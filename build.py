#!/usr/bin/env python3
"""Inline src/* into one self-contained HTML file: dist/InfraBeat_SD_Operations_Agent.html"""
import pathlib
root = pathlib.Path(__file__).parent
src = root / 'src'
html = (src / 'index.html').read_text(encoding='utf-8')
style = '<style>\n' + (src / 'style.css').read_text(encoding='utf-8') + '\n</style>'
scripts = '<script>\n' + '\n\n'.join((src / f).read_text(encoding='utf-8') for f in ['util.js', 'data.js', 'sap.js', 'catalog.js', 'app.js']) + '\n</script>'
out = html.replace('<!--BUILD:STYLE-->', style).replace('<!--BUILD:SCRIPTS-->', scripts)
dist = root / 'dist'; dist.mkdir(exist_ok=True)
(dist / 'InfraBeat_SD_Operations_Agent.html').write_text(out, encoding='utf-8')
print('built', dist / 'InfraBeat_SD_Operations_Agent.html', len(out), 'bytes')
