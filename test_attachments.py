import io
import struct
import unittest
import zlib
from zipfile import ZipFile

from pypdf import PdfWriter

from collect_attachments import _public_result, download_url, group_attachments, sample_candidates
from document_text import DocumentError, _hwp_records, _hwp_text, _inflate_hwp_section, extract_document


def zip_doc(name, xml, **additional):
    stream = io.BytesIO()
    with ZipFile(stream, "w") as archive:
        archive.writestr(name, xml)
        for path, data in additional.items():
            archive.writestr(path, data)
    return stream.getvalue()


class AttachmentTest(unittest.TestCase):
    def test_rows_match_notice_and_revision(self):
        notices = [{"noticeId": "R26BK00000001", "revision": "002"}]
        url = "https://www.g2b.go.kr/sample/example.pdf"
        row = {
            "bidNtceNo": "R26BK00000001", "bidNtceOrd": 2,
            "atchFileNm": "입찰공고문.pdf", "atchFileUrl": url, "atchDocDivNm": "공고서",
        }
        grouped, skipped = group_attachments([row, row, {**row, "bidNtceOrd": 1}], notices, "unit-only-marker")
        self.assertEqual(skipped, 0)
        files = grouped["R26BK00000001:002"]
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0]["format"], "pdf")
        self.assertEqual(files[0]["category"], "공고문")
        self.assertEqual(files[0]["sourceUrl"], url)
        self.assertEqual(len(list(sample_candidates(grouped, 16))), 1)

    def test_download_host_and_credential_guards(self):
        for url in (
            "https://www.g2b.go.kr.example.com/sample.pdf", "http://www.g2b.go.kr/a.pdf",
            "https://user:password@www.g2b.go.kr/a.pdf",
            "https://www.g2b.go.kr/a.pdf?service%4Bey=example",
            "https://www.g2b.go.kr:9999/a.pdf", "https://www.g2b.go.kr/%5Cfake",
        ):
            with self.subTest(url=url):
                self.assertIsNone(download_url(url))

    def test_txt_unicode_and_cp949(self):
        self.assertEqual(extract_document("한글\n본문".encode("utf-8"), "txt")["parts"][1],
                         {"line": 2, "text": "본문"})
        self.assertEqual(extract_document("한글 본문".encode("cp949"), "txt")["parts"][0]["text"], "한글 본문")

    def test_docx_table_and_paragraphs(self):
        xml = "<document><body><p><r><t>공고문</t></r></p><tbl><tr><tc><p><r><t>품명</t></r></p></tc></tr></tbl></body></document>"
        parsed = extract_document(zip_doc("word/document.xml", xml), "docx")
        self.assertEqual(parsed["status"], "success")
        self.assertEqual([p["text"] for p in parsed["parts"]], ["공고문", "품명"])
        self.assertTrue(parsed["parts"][1]["table"])
        self.assertIn("table_linear", parsed["warnings"])
        public = _public_result(parsed)
        self.assertNotIn("parts", public)
        self.assertNotIn("품명", str(public))

    def test_hwpx_section_and_xml_protection(self):
        parsed = extract_document(zip_doc("Contents/section0.xml", "<sec><p><run><t>요청서</t></run></p></sec>"), "hwpx")
        self.assertEqual(parsed["parts"][0], {"text": "요청서", "paragraph": 1, "section": 1, "table": False})
        dtd = '<!DOCTYPE sec [<!ENTITY secret SYSTEM "file:///etc/passwd">]><sec><p><t>&secret;</t></p></sec>'
        self.assertEqual(extract_document(zip_doc("Contents/section0.xml", dtd), "hwpx")["reason"], "unsafe_archive")

    def test_unsafe_zip_path(self):
        data = zip_doc("word/document.xml", "<document/>", **{"../escape.txt": "ignored"})
        self.assertEqual(extract_document(data, "docx")["reason"], "unsafe_archive")

    def test_hwp_records_and_controls(self):
        text = "한글".encode("utf-16-le") + b"\t\x00" * 8 + "입찰".encode("utf-16-le")
        record = struct.pack("<I", 67 | (len(text) << 20)) + text
        tag, payload = next(_hwp_records(record))
        self.assertEqual(tag, 67)
        self.assertEqual(_hwp_text(payload), "한글\t입찰")

    def test_hwp_compressed_section_trailer(self):
        original = "한글 공고".encode("utf-16-le")
        compressor = zlib.compressobj(wbits=-15)
        raw = compressor.compress(original) + compressor.flush()
        trailer = struct.pack("<II", zlib.crc32(original), len(original))
        self.assertEqual(_inflate_hwp_section(raw, 1024), original)
        self.assertEqual(_inflate_hwp_section(raw + trailer, 1024), original)
        with self.assertRaisesRegex(DocumentError, "invalid_document"):
            _inflate_hwp_section(raw + b"\0" * 8, 1024)
        with self.assertRaisesRegex(DocumentError, "expanded_limit"):
            _inflate_hwp_section(raw + trailer, 1)

    def test_pdf_no_text_encrypted_and_wrong_format(self):
        blank = PdfWriter()
        blank.add_blank_page(width=210, height=297)
        plain = io.BytesIO()
        blank.write(plain)
        self.assertEqual(extract_document(plain.getvalue(), "pdf")["reason"], "no_text_layer")
        locked = io.BytesIO()
        blank.encrypt("fixture-only")
        blank.write(locked)
        self.assertEqual(extract_document(locked.getvalue(), "pdf")["reason"], "encrypted")
        self.assertEqual(extract_document(b"<html>wrong</html>", "pdf")["reason"], "wrong_format")


if __name__ == "__main__":
    unittest.main()
