from html import escape
import os
from pathlib import Path
import re
from xml.etree import ElementTree


base = Path("build_uspevator")
shell = (base / "shell.html").read_text()
css = (base / "style.css").read_text()
js = "\n".join((base / name).read_text() for name in ("i18n.js", "core.js", "ui.js", "tests.js"))
assert "</script" not in js.lower()

manifest = ElementTree.parse("android_uspevator/app/AndroidManifest.xml").getroot()
version = manifest.attrib["{http://schemas.android.com/apk/res/android}versionName"]
license_text = Path("LICENSE").read_text(encoding="utf-8")
commit = os.environ.get("GITHUB_SHA", "")
archive_ref = commit if re.fullmatch(r"[0-9a-f]{40}", commit) else f"refs/tags/v{version}"
source_url = f"https://github.com/hazgon/uspevator/archive/{archive_ref}.zip"

compiled = (shell.replace("/* APP_VERSION */", escape(version))
    .replace("/* APP_SOURCE_URL */", escape(source_url))
    .replace("/* APP_LICENSE */", escape(license_text, quote=False))
    .replace("/* APP_CSS */", css)
    .replace("/* APP_JS */", js + "\nboot();\n"))
Path("uspevator.html").write_text(compiled)
(base / "preview" / "dist").mkdir(parents=True, exist_ok=True)
(base / "preview" / "dist" / "index.html").write_text(compiled)
(base / "test-run.js").write_text(js + "\nconst result = runSelfTests(); process.exitCode = result.passed === result.total ? 0 : 1;\n")

