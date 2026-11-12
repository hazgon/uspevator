from pathlib import Path

base = Path("build_uspevator")
shell = (base / "shell.html").read_text()
css = (base / "style.css").read_text()
js = "\n".join((base / name).read_text() for name in ("i18n.js", "core.js", "ui.js", "tests.js"))
assert "</script" not in js.lower()
compiled = shell.replace("/* APP_CSS */", css).replace("/* APP_JS */", js + "\nboot();\n")
Path("uspevator.html").write_text(compiled)
(base / "preview" / "dist").mkdir(parents=True, exist_ok=True)
(base / "preview" / "dist" / "index.html").write_text(compiled)
(base / "test-run.js").write_text(js + "\nconst result = runSelfTests(); process.exitCode = result.passed === result.total ? 0 : 1;\n")

