# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['..\\..\\xml_legacy_tk.py'],
    pathex=[],
    binaries=[],
    datas=[('C:\\XMLs\\Compactar XML V4\\xml_icon_multi.ico', '.')],
    hiddenimports=[],
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
    a.datas,
    [],
    name='Gerenciador de XML Sem UI',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['C:\\XMLs\\Compactar XML V4\\xml_icon_multi.ico'],
)
