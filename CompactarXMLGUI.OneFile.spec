# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules


PROJECT_ROOT = Path(SPECPATH)
FRONTEND_DIST_DIR = PROJECT_ROOT / 'frontend' / 'dist'
ICON_PATH = PROJECT_ROOT / 'xml_icon_multi.ico'


def collect_tree(source: Path, target_root: str):
    items = []
    if not source.exists():
        return items

    for path in source.rglob('*'):
        if path.is_file():
            relative_parent = path.relative_to(source).parent
            target_dir = Path(target_root) / relative_parent
            items.append((str(path), str(target_dir)))
    return items


datas = []
if ICON_PATH.exists():
    datas.append((str(ICON_PATH), '.'))

datas += collect_tree(FRONTEND_DIST_DIR, 'frontend/dist')
datas += collect_data_files('webview')

hiddenimports = []
hiddenimports += collect_submodules('webview')
hiddenimports += collect_submodules('pythonnet')
hiddenimports += collect_submodules('clr_loader')


a = Analysis(
    ['xml_explorer_gui.py'],
    pathex=[str(PROJECT_ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='Gerenciador de XML OneFile',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    icon=[str(ICON_PATH)],
    codesign_identity=None,
    entitlements_file=None,
)
