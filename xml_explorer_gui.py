from __future__ import annotations

import os
import site
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


PROJECT_ROOT = Path(__file__).resolve().parent
VENDOR_DIR = PROJECT_ROOT / 'vendor'
USER_SITE_DIR = Path(site.getusersitepackages())


def _path_contains_webview_package(base_dir: Path) -> bool:
    try:
        return (base_dir / 'webview' / '__init__.py').exists() or (base_dir / 'webview.py').exists()
    except OSError:
        return False


for candidate in (VENDOR_DIR, USER_SITE_DIR):
    try:
        candidate_exists = bool(candidate) and candidate.exists()
    except OSError:
        continue

    if candidate_exists and _path_contains_webview_package(candidate):
        candidate_str = str(candidate)
        if candidate_str not in sys.path:
            sys.path.insert(0, candidate_str)

import webview

if not hasattr(webview, 'create_window') or not hasattr(webview, 'start'):
    raise SystemExit('pywebview nao foi carregado corretamente. Verifique a instalacao do pacote antes de iniciar o app.')

from xml_app_core import APP_TITLE, ICON_ICO_NAME, XmlAppService, resolve_base_path, resource_path


class WebviewApi:
    def __init__(self, service: XmlAppService) -> None:
        self.service = service
        self.window: Optional[webview.Window] = None

    def bind_window(self, window: webview.Window) -> None:
        self.window = window

    def get_initial_state(self) -> Dict[str, object]:
        return self.service.get_initial_state()

    def getInitialState(self) -> Dict[str, object]:
        return self.get_initial_state()

    def load_startup_context(self) -> Dict[str, object]:
        return self.service.load_startup_context()

    def loadStartupContext(self) -> Dict[str, object]:
        return self.load_startup_context()

    def choose_base_path(self, current_path: str = '') -> Dict[str, object]:
        if self.window is None:
            return {'ok': False, 'message': 'Janela principal indisponivel para selecionar pasta.'}

        initial_dir = current_path.strip() or str(Path.home())
        try:
            result = self.window.create_file_dialog(webview.FOLDER_DIALOG, directory=initial_dir)
        except Exception as exc:
            return {'ok': False, 'message': f'Nao foi possivel abrir o seletor de pasta: {exc}'}

        selected = _first_dialog_result(result)
        if not selected:
            return {'ok': False, 'cancelled': True, 'message': 'Selecao de pasta cancelada.'}

        return {
            'ok': True,
            'path': str(resolve_base_path(selected)),
            'message': 'Pasta selecionada com sucesso.',
        }

    def save_base_path(self, base_path: str) -> Dict[str, object]:
        return self.service.save_base_path(base_path)

    def detect_from_danfe(self) -> Dict[str, object]:
        return self.service.detect_from_danfe()

    def detect_default_base(self) -> Dict[str, object]:
        return self.service.detect_default_base()

    def test_structure(self, base_path: str) -> Dict[str, object]:
        return self.service.test_structure(base_path, persist=False)

    def start_scan(self, payload: Dict[str, Any]) -> Dict[str, object]:
        return self.service.start_scan(
            str(payload.get('basePath', '')),
            str(payload.get('startDate', '')),
            str(payload.get('endDate', '')),
        )

    def get_scan_job(self, job_id: str) -> Dict[str, object]:
        return self.service.get_scan_job(job_id)

    def save_selected_zip(self, payload: Dict[str, Any]) -> Dict[str, object]:
        if self.window is None:
            return {'ok': False, 'message': 'Janela principal indisponivel para salvar o ZIP.'}

        note_ids = _ensure_string_list(payload.get('noteIds'))
        start_date = str(payload.get('startDate', ''))
        end_date = str(payload.get('endDate', ''))
        default_name = self.service.default_zip_name(start_date, end_date)

        try:
            result = self.window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=default_name,
                file_types=('Arquivo ZIP (*.zip)',),
            )
        except Exception as exc:
            return {'ok': False, 'message': f'Nao foi possivel abrir o salvamento do ZIP: {exc}'}

        target_path = _first_dialog_result(result)
        if not target_path:
            return {'ok': False, 'cancelled': True, 'message': 'Salvamento do ZIP cancelado.'}

        return self.service.save_notes_zip(note_ids, target_path, start_date, end_date)

    def save_note_copy(self, note_id: str) -> Dict[str, object]:
        if self.window is None:
            return {'ok': False, 'message': 'Janela principal indisponivel para salvar o XML.'}

        default_name = self.service.default_xml_name(note_id)
        try:
            result = self.window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=default_name,
                file_types=('Arquivo XML (*.xml)', 'Todos os arquivos (*.*)'),
            )
        except Exception as exc:
            return {'ok': False, 'message': f'Nao foi possivel abrir o salvamento do XML: {exc}'}

        target_path = _first_dialog_result(result)
        if not target_path:
            return {'ok': False, 'cancelled': True, 'message': 'Salvamento do XML cancelado.'}

        return self.service.copy_note_to(note_id, target_path)

    def open_note_location(self, note_id: str) -> Dict[str, object]:
        return self.service.open_note_location(note_id)

    def get_note_xml_preview(self, note_id: str) -> Dict[str, object]:
        return self.service.get_note_xml_preview(note_id)


def _first_dialog_result(result: Any) -> str:
    if not result:
        return ''
    if isinstance(result, (list, tuple)):
        return str(result[0]) if result else ''
    return str(result)


def _ensure_string_list(value: Any) -> List[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    return []


def _expose_window_api(window: webview.Window, api: WebviewApi) -> None:
    window.expose(
        api.get_initial_state,
        api.getInitialState,
        api.load_startup_context,
        api.loadStartupContext,
        api.choose_base_path,
        api.save_base_path,
        api.detect_from_danfe,
        api.detect_default_base,
        api.test_structure,
        api.start_scan,
        api.get_scan_job,
        api.save_selected_zip,
        api.save_note_copy,
        api.open_note_location,
        api.get_note_xml_preview,
    )


def main() -> None:
    root_dir = resource_root()
    os.chdir(root_dir)

    index_path = root_dir / 'frontend' / 'dist' / 'index.html'
    if not index_path.exists():
        raise SystemExit(
            'Frontend nao encontrado em frontend/dist. Rode `npm run build` na pasta frontend antes de iniciar o app.'
        )

    service = XmlAppService()
    api = WebviewApi(service)

    window = webview.create_window(
        APP_TITLE,
        url='frontend/dist/index.html',
        js_api=api,
        width=1460,
        height=920,
        min_size=(840, 620),
        resizable=True,
        confirm_close=False,
        background_color='#020817',
        text_select=True,
    )
    if window is None:
        raise SystemExit('Nao foi possivel criar a janela principal.')

    api.bind_window(window)
    _expose_window_api(window, api)

    def maximize_on_start() -> None:
        maximize = getattr(window, 'maximize', None)
        if callable(maximize):
            try:
                maximize()
            except Exception:
                pass

    webview.start(
        maximize_on_start,
        debug=False,
        http_server=True,
        private_mode=True,
        icon=str(resource_path(ICON_ICO_NAME)),
    )


def resource_root() -> Path:
    if hasattr(sys, '_MEIPASS'):
        return Path(sys._MEIPASS)
    return PROJECT_ROOT


if __name__ == '__main__':
    main()


