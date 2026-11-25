import { loadPyodide } from "./vendor/pyodide-314.0.8/pyodide.mjs";

let runtime;

async function prepareRuntime() {
  const indexURL = new URL("./vendor/pyodide-314.0.8/", import.meta.url).href;
  const response = await fetch(new URL("./requirement_rules.py?v=5b1", import.meta.url));
  if (!response.ok) throw Error("rules_unavailable");
  const source = await response.text();
  const python = await loadPyodide({ indexURL, stdout: () => {}, stderr: () => {} });
  python.FS.writeFile("requirement_rules.py", source);
  return python;
}

self.onmessage = async ({ data }) => {
  try {
    const python = await (runtime ??= prepareRuntime());
    python.globals.set("_document_json", JSON.stringify(data.documents));
    try {
      // Only trusted fixed code is executable. Document text is passed as data.
      const result = python.runPython(
        "import json\nfrom requirement_rules import summarize_documents\n" +
        (data.separate ?
          "json.dumps([summarize_documents([doc]) for doc in json.loads(_document_json)], ensure_ascii=False)" :
          "json.dumps(summarize_documents(json.loads(_document_json)), ensure_ascii=False)")
      );
      self.postMessage({ fields: JSON.parse(result) });
    } finally {
      python.globals.delete("_document_json");
    }
  } catch {
    self.postMessage({ error: "rules_unavailable" });
  }
};
