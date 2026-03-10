@echo off
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python nao encontrado no PATH.
  exit /b 1
)

python -m PyInstaller --version >nul 2>nul
if errorlevel 1 (
  echo PyInstaller nao encontrado.
  echo Instale com: python -m pip install pyinstaller
  exit /b 1
)

if not exist "%~dp0frontend\package.json" (
  echo Pasta frontend nao encontrada.
  exit /b 1
)

echo.
echo [1/2] Gerando frontend React...
pushd "%~dp0frontend"
call npm.cmd run build
if errorlevel 1 (
  popd
  echo Falha ao gerar frontend.
  exit /b 1
)
popd

echo.
echo [2/2] Gerando executavel...
python -m PyInstaller --noconfirm --clean ^
  "CompactarXMLGUI.spec"

if errorlevel 1 (
  echo Falha ao gerar executavel.
  exit /b 1
)

echo.
echo Executavel gerado em:
echo %~dp0dist\Gerenciador de XML\Gerenciador de XML.exe

endlocal

