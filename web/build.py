#!/usr/bin/env python3
"""Build the static HTML5 (WebAssembly) version of the Web GUI.

The page markup is taken from HTML_PAGE in web_gui.py so the desktop and
browser versions share one frontend; api-shim.js redirects its /api/* calls
to the engine in engine-worker.js.

Requires wasm-pack and the wasm32-unknown-unknown Rust target.

    python web/build.py [OUT_DIR]   # default: site/
"""

import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / 'web'


def extract_html():
    src = (ROOT / 'web_gui.py').read_text(encoding='utf-8')
    m = re.search(r'^HTML_PAGE = r"""(.*?)^"""', src, re.S | re.M)
    if not m:
        sys.exit('HTML_PAGE not found in web_gui.py')
    html = m.group(1)
    # Load the shim before the GUI script so its initial fetchState() is intercepted
    html, n = re.subn(r'<script>', '<script src="api-shim.js"></script>\n<script>', html, count=1)
    if n != 1:
        sys.exit('<script> tag not found in HTML_PAGE')
    return html


def main():
    out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / 'site'
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    subprocess.run(
        ['wasm-pack', 'build', '--target', 'web', '--release', '--no-pack',
         '--out-dir', str(out / 'pkg'), str(ROOT), '--', '--features', 'wasm'],
        check=True,
    )
    (out / 'pkg' / '.gitignore').unlink(missing_ok=True)

    (out / 'index.html').write_text(extract_html(), encoding='utf-8')
    for name in ('api-shim.js', 'engine-worker.js'):
        shutil.copy(WEB / name, out / name)
    (out / '.nojekyll').touch()
    print(f'Built static site in {out}')


if __name__ == '__main__':
    main()
