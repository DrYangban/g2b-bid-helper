"""Read attachment text without opening an office application."""

import codecs
import io
import json
import logging
import re
import struct
import sys
import zlib
from pathlib import Path, PurePosixPath
from zipfile import BadZipFile, ZipFile

import olefile
from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException
from pypdf import PdfReader
from pypdf.errors import PdfReadError


MAX_FILE = 12 * 1024 * 1024
MAX_EXPANDED = 32 * 1024 * 1024
MAX_PARTS = 4_000
MAX_TEXT = 150_000
MAX_PAGES = 60
SUPPORTED = ("pdf", "hwp", "hwpx", "docx", "txt")
OLE_HEADER = bytes.fromhex("D0CF11E0A1B11AE1")
HWP_EXTENDED = {1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23}
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class DocumentError(ValueError):
    pass


class Extraction:
    def __init__(self):
        self.parts = []
        self.characters = 0
        self.warnings = set()

    def add(self, text, **location):
        clean = CONTROL.sub("", text).strip()
        if not clean:
            return
        available = MAX_TEXT - self.characters
        if len(self.parts) >= MAX_PARTS or available <= 0:
            self.warnings.add("text_limit")
            return
        if len(clean) > available:
            self.warnings.add("text_limit")
            clean = clean[:available]
        self.characters += len(clean)
        self.parts.append({**location, "text": clean})

    def finish(self):
        text = "\n\n".join(part["text"] for part in self.parts)
        hangul = len(re.findall(r"[가-힣]", text))
        replacement = text.count("\ufffd") + len(re.findall(r"\(cid:\d+\)", text))
        if replacement:
            self.warnings.add("unmapped_characters")
        incomplete = self.warnings - {"pdf_layout", "table_linear", "body_only"}
        return {
            "status": "partial" if incomplete else "success",
            "reason": None,
            "parts": self.parts,
            "warnings": sorted(self.warnings),
            "characters": self.characters,
            "hangul": hangul,
            "replacement": replacement,
        }


def _failure(reason):
    return {
        "status": "failed", "reason": reason, "parts": [], "warnings": [],
        "characters": 0, "hangul": 0, "replacement": 0,
    }


def _pdf(data, result):
    if b"%PDF-" not in data[:1024]:
        raise DocumentError("wrong_format")
    logging.getLogger("pypdf").disabled = True
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        raise DocumentError("encrypted")
    result.warnings.add("pdf_layout")
    if len(reader.pages) > MAX_PAGES:
        result.warnings.add("page_limit")
    for number in range(min(len(reader.pages), MAX_PAGES)):
        try:
            page = reader.pages[number]
            text = page.extract_text(extraction_mode="layout") or ""
        except (PdfReadError, ValueError, TypeError, KeyError, NotImplementedError, OverflowError):
            result.warnings.add("unreadable_page")
            continue
        if not text.strip():
            result.warnings.add("page_without_text")
        result.add(text, page=number + 1)


def _zip_parts(data, fmt, result):
    if data.startswith(OLE_HEADER) and fmt == "docx":
        with olefile.OleFileIO(io.BytesIO(data)) as document:
            if document.exists("EncryptedPackage"):
                raise DocumentError("encrypted")
    if not data.startswith(b"PK\x03\x04"):
        raise DocumentError("wrong_format")
    with ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 2_000 or sum(entry.file_size for entry in entries) > 96 * 1024 * 1024:
            raise DocumentError("expanded_limit")
        names = set()
        for entry in entries:
            path = PurePosixPath(entry.filename)
            if path.is_absolute() or ".." in path.parts or "\\" in entry.filename or ":" in entry.filename:
                raise DocumentError("unsafe_archive")
            if entry.filename in names:
                raise DocumentError("unsafe_archive")
            names.add(entry.filename)
        if fmt == "docx":
            selected = ["word/document.xml"] if "word/document.xml" in names else []
        else:
            selected = sorted(
                (name for name in names if re.fullmatch(r"Contents/section\d+\.xml", name)),
                key=lambda name: int(re.search(r"\d+", name)[0]),
            )
        if not selected:
            raise DocumentError("wrong_format")
        if len(selected) > MAX_PAGES or sum(archive.getinfo(n).file_size for n in selected) > MAX_EXPANDED:
            raise DocumentError("expanded_limit")
        result.warnings.add("body_only")
        if any(re.match(r"^(word/media/|BinData/)", name) for name in names):
            result.warnings.add("images_skipped")
        for index, name in enumerate(selected, 1):
            entry = archive.getinfo(name)
            if entry.flag_bits & 1:
                raise DocumentError("encrypted")
            with archive.open(entry) as stream:
                xml = stream.read(MAX_EXPANDED + 1)
            if len(xml) > MAX_EXPANDED:
                raise DocumentError("expanded_limit")
            root = ElementTree.fromstring(xml, forbid_dtd=True, forbid_entities=True, forbid_external=True)
            _xml_paragraphs(root, result, section=index if fmt == "hwpx" else None)


def _xml_paragraphs(root, result, section):
    def local(tag):
        return tag.rsplit("}", 1)[-1]

    stack = [(root, False)]
    paragraph = 0
    while stack:
        node, in_table = stack.pop()
        tag = local(node.tag)
        in_table = in_table or tag == "tbl"
        if tag == "tbl":
            result.warnings.add("table_linear")
        if tag == "p":
            paragraph += 1
            chunks = []
            children = list(reversed(node))
            while children:
                child = children.pop()
                child_tag = local(child.tag)
                if child_tag == "t":
                    chunks.append(child.text or "")
                    children.extend(reversed(child))
                elif child_tag in {"br", "lineBreak", "tab"}:
                    chunks.append("\t" if child_tag == "tab" else "\n")
                elif child_tag not in {"p", "tbl", "drawing", "pict", "pic", "object", "del", "moveFrom"}:
                    children.extend(reversed(child))
            result.add("".join(chunks), paragraph=paragraph, section=section, table=in_table)
        if tag not in {"drawing", "pict", "pic", "object", "del", "moveFrom"}:
            stack.extend((child, in_table) for child in reversed(node))


def _hwp_text(data):
    if len(data) % 2:
        raise DocumentError("invalid_document")
    output = bytearray()
    position = 0
    while position < len(data):
        code = struct.unpack_from("<H", data, position)[0]
        if code in HWP_EXTENDED:
            if position + 16 > len(data):
                raise DocumentError("invalid_document")
            if code == 9:
                output.extend(b"\t\x00")
            position += 16
            continue
        if code in {10, 13}:
            output.extend(b"\n\x00")
        elif code == 30 or code == 31:
            output.extend(b" \x00")
        elif code >= 32:
            output.extend(data[position:position + 2])
        position += 2
    return output.decode("utf-16-le", errors="replace")


def _hwp_records(data):
    position = 0
    while position + 4 <= len(data):
        header = struct.unpack_from("<I", data, position)[0]
        position += 4
        size = header >> 20
        if size == 0xFFF:
            if position + 4 > len(data):
                raise DocumentError("invalid_document")
            size = struct.unpack_from("<I", data, position)[0]
            position += 4
        end = position + size
        if end > len(data):
            raise DocumentError("invalid_document")
        yield header & 0x3FF, memoryview(data)[position:end]
        position = end
    if position != len(data):
        raise DocumentError("invalid_document")


def _hwp(data, result):
    if not data.startswith(OLE_HEADER):
        raise DocumentError("wrong_format")
    with olefile.OleFileIO(io.BytesIO(data)) as document:
        if not document.exists("FileHeader"):
            raise DocumentError("wrong_format")
        with document.openstream("FileHeader") as stream:
            header = stream.read(40)
        if len(header) < 40 or not header.startswith(b"HWP Document File") or header[35] != 5:
            raise DocumentError("wrong_format")
        flags = struct.unpack_from("<I", header, 36)[0]
        if flags & 0b0101_0001_0110:
            raise DocumentError("encrypted")
        streams = sorted(
            (name for name in document.listdir() if len(name) == 2 and
             name[0] == "BodyText" and re.fullmatch(r"Section\d+", name[1])),
            key=lambda name: int(name[1][7:]),
        )
        if len(streams) > MAX_PAGES:
            raise DocumentError("expanded_limit")
        if not streams:
            raise DocumentError("no_text")
        remaining = MAX_EXPANDED
        result.warnings.add("body_only")
        for name in streams:
            if document.get_size(name) > MAX_FILE:
                raise DocumentError("expanded_limit")
            with document.openstream(name) as stream:
                section = stream.read(MAX_FILE + 1)
            if len(section) > MAX_FILE:
                raise DocumentError("expanded_limit")
            if flags & 1:
                inflater = zlib.decompressobj(-15)
                section = inflater.decompress(section, remaining + 1)
                if not inflater.eof and len(section) <= remaining:
                    raise DocumentError("invalid_document")
            remaining -= len(section)
            if remaining < 0:
                raise DocumentError("expanded_limit")
            paragraph = 0
            for tag, payload in _hwp_records(section):
                if tag == 77:
                    result.warnings.add("table_linear")
                if tag == 85:
                    result.warnings.add("images_skipped")
                if tag == 67:
                    paragraph += 1
                    result.add(_hwp_text(payload), paragraph=paragraph, section=int(name[1][7:]) + 1)


def _txt(data, result):
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        encoding = "utf-16"
    else:
        encoding = "utf-8-sig"
        try:
            data.decode(encoding)
        except UnicodeDecodeError:
            encoding = "cp949"
    text = data.decode(encoding)
    if CONTROL.sub("", text) != text or re.match(r"\s*<(?:!doctype html|html\b)", text, re.I):
        raise DocumentError("wrong_format")
    for number, line in enumerate(text.splitlines(), 1):
        result.add(line, line=number)


def extract_document(data, fmt):
    if fmt not in SUPPORTED:
        return _failure("unsupported")
    if len(data) > MAX_FILE:
        return _failure("file_limit")
    result = Extraction()
    try:
        if fmt == "pdf":
            _pdf(data, result)
        elif fmt == "hwp":
            _hwp(data, result)
        elif fmt in {"hwpx", "docx"}:
            _zip_parts(data, fmt, result)
        else:
            _txt(data, result)
    except DocumentError as error:
        return _failure(str(error))
    except DefusedXmlException:
        return _failure("unsafe_archive")
    except (BadZipFile, PdfReadError, UnicodeError, ValueError, TypeError, KeyError, OSError,
            SyntaxError, OverflowError, RuntimeError, zlib.error, struct.error):
        return _failure("invalid_document")
    if not result.parts:
        return _failure("no_text_layer" if fmt == "pdf" else "no_text")
    return result.finish()


def main():
    if sys.platform.startswith("linux"):
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024**2, 512 * 1024**2))
        resource.setrlimit(resource.RLIMIT_CPU, (12, 12))
    data = Path(sys.argv[2]).stat().st_size
    outcome = _failure("file_limit") if data > MAX_FILE else extract_document(Path(sys.argv[2]).read_bytes(), sys.argv[1])
    sys.stdout.buffer.write(json.dumps(outcome, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
