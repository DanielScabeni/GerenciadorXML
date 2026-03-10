from __future__ import annotations

import calendar
import json
import os
import re
import shutil
import string
import subprocess
import sys
import time
import zipfile
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
import xml.etree.ElementTree as ET


APP_TITLE = "Gerenciador de XML"
CONFIG_DIR_NAME = "CompactarXMLV4"
CONFIG_FILE_NAME = "config.json"
ICON_ICO_NAME = "xml_icon_multi.ico"

CNPJ_RE = re.compile(r"^\d{14}$")
KEY_RE = re.compile(r"(?<!\d)(\d{44})(?!\d)")
CTE_DIR_CANDIDATES = ("UniCTe", "UniCTE", "Unicte", "CTe", "CTE")
DANFE_INI_RELATIVE_PATH = Path("ControlGas") / "Ini" / "DANFE.ini"
PASTA_UNINFE_LINE_RE = re.compile(r"^\s*PastaUniNFE\s*=\s*(.+?)\s*$", re.IGNORECASE)
REMOTE_HOST_DRIVE_RE = re.compile(
    r"^\s*([A-Za-z0-9_.-]+)\s*:\s*([A-Za-z])\s*:[\\/](.*)\s*$"
)

MONTH_NAMES_PT = (
    "janeiro",
    "fevereiro",
    "marco",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
)
WEEKDAY_SHORT_PT = ("D", "S", "T", "Q", "Q", "S", "S")


@dataclass
class NoteRecord:
    doc_type: str
    cnpj: str
    key: str
    number: str
    series: str
    issue_date: Optional[date]
    file_path: Path


def local_name(tag: str) -> str:
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def parse_issue_date(raw_text: str) -> Optional[date]:
    value = (raw_text or "").strip()
    if not value:
        return None

    first_ten = value[:10]
    if (
        len(first_ten) == 10
        and first_ten[4] in "-/"
        and first_ten[7] in "-/"
        and first_ten[:4].isdigit()
        and first_ten[5:7].isdigit()
        and first_ten[8:10].isdigit()
    ):
        try:
            return date(int(first_ten[:4]), int(first_ten[5:7]), int(first_ten[8:10]))
        except ValueError:
            pass

    first_eight = value[:8]
    if len(first_eight) == 8 and first_eight.isdigit():
        try:
            return date(int(first_eight[:4]), int(first_eight[4:6]), int(first_eight[6:8]))
        except ValueError:
            pass

    for fmt, source in (("%Y-%m-%d", first_ten), ("%Y/%m/%d", first_ten), ("%Y%m%d", value)):
        try:
            return datetime.strptime(source, fmt).date()
        except ValueError:
            pass

    return None

def format_date_br(value: Optional[date]) -> str:
    if value is None:
        return ""
    return value.strftime("%d/%m/%Y")


def parse_date_br(value: str) -> Optional[date]:
    text = value.strip()
    if not text:
        return None

    for fmt in ("%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            pass

    return None


def normalize_access_key(raw_key: str) -> str:
    digits = "".join(ch for ch in raw_key if ch.isdigit())
    if len(digits) == 44:
        return digits
    return ""


def extract_number_series_from_key(key: str) -> Tuple[str, str]:
    if len(key) != 44 or not key.isdigit():
        return "", ""

    raw_series = key[22:25]
    raw_number = key[25:34]
    series = str(int(raw_series)) if raw_series.isdigit() else ""
    number = str(int(raw_number)) if raw_number.isdigit() else ""
    return number, series


def parse_note_from_xml(xml_path: Path, doc_type: str, cnpj: str) -> Optional[NoteRecord]:
    expected_tags = {"infCte", "infCTe"} if doc_type == "CT-e" else {"infNFe"}
    number_tag = "nCT" if doc_type == "CT-e" else "nNF"

    key = ""
    number = ""
    series = ""
    issue: Optional[date] = None
    valid_invoice = False
    inside_ide = False
    context = None

    try:
        context = ET.iterparse(xml_path, events=("start", "end"))
        for event, elem in context:
            tag_name = local_name(elem.tag)

            if event == "start":
                if tag_name == "ide":
                    inside_ide = True
                if tag_name in expected_tags:
                    valid_invoice = True
                    if not key:
                        key = normalize_access_key(elem.attrib.get("Id", ""))
                continue

            text = (elem.text or "").strip()
            if tag_name == "ide":
                inside_ide = False
            elif inside_ide:
                if not number and tag_name == number_tag and text:
                    number = text
                elif not series and tag_name == "serie" and text:
                    series = text
                elif issue is None and tag_name in ("dhEmi", "dEmi") and text:
                    issue = parse_issue_date(text)
            elif issue is None and tag_name in ("dhEmi", "dEmi") and text:
                issue = parse_issue_date(text)

            if not key and tag_name in ("chNFe", "chCTe") and text:
                key = normalize_access_key(text)

            elem.clear()

            if valid_invoice and key and number and series and issue is not None:
                break
    except Exception:
        return None
    finally:
        if context is not None and hasattr(context, "close"):
            try:
                context.close()
            except Exception:
                pass

    if not valid_invoice:
        return None

    if not key:
        match = KEY_RE.search(xml_path.name)
        if match:
            key = match.group(1)

    if not key:
        return None

    key_number, key_series = extract_number_series_from_key(key)
    if not number:
        number = key_number
    if not series:
        series = key_series

    return NoteRecord(
        doc_type=doc_type,
        cnpj=cnpj,
        key=key,
        number=number or "-",
        series=series or "-",
        issue_date=issue,
        file_path=xml_path,
    )

def rank_file(doc_type: str, file_name: str) -> int:
    name = file_name.lower()
    score = 0

    if "proc" in name:
        score += 2

    if doc_type == "NF-e" and ("procnfe" in name or "nfeproc" in name):
        score += 4
    elif doc_type == "NFC-e" and ("procnfce" in name or "nfceproc" in name):
        score += 4
    elif doc_type == "CT-e" and ("proccte" in name or "cteproc" in name):
        score += 4

    return score


def choose_better_record(current: NoteRecord, challenger: NoteRecord) -> NoteRecord:
    current_score = rank_file(current.doc_type, current.file_path.name)
    challenger_score = rank_file(challenger.doc_type, challenger.file_path.name)
    if challenger_score != current_score:
        return challenger if challenger_score > current_score else current

    try:
        current_mtime = current.file_path.stat().st_mtime
    except OSError:
        current_mtime = 0.0

    try:
        challenger_mtime = challenger.file_path.stat().st_mtime
    except OSError:
        challenger_mtime = 0.0

    return challenger if challenger_mtime >= current_mtime else current


def deduplicate_records(records: List[NoteRecord]) -> List[NoteRecord]:
    chosen: Dict[Tuple[str, str, str], NoteRecord] = {}
    for record in records:
        key = (record.doc_type, record.cnpj, record.key)
        previous = chosen.get(key)
        if previous is None:
            chosen[key] = record
        else:
            chosen[key] = choose_better_record(previous, record)

    return sorted(
        chosen.values(),
        key=lambda r: (
            r.cnpj,
            r.doc_type,
            r.issue_date or date.min,
            int(r.number) if r.number.isdigit() else 0,
            r.key,
        ),
    )


def month_tokens_between(start_date: date, end_date: date) -> Tuple[set[str], set[str]]:
    full_tokens = set()
    short_tokens = set()

    cursor = date(start_date.year, start_date.month, 1)
    last_month = date(end_date.year, end_date.month, 1)

    while cursor <= last_month:
        full_tokens.add(cursor.strftime("%Y%m"))
        short_tokens.add(cursor.strftime("%y%m"))
        cursor = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)

    return full_tokens, short_tokens


def folder_matches_any_token(folder_name: str, tokens: set[str]) -> bool:
    digits_only = "".join(ch for ch in folder_name if ch.isdigit())
    for token in tokens:
        if folder_name == token:
            return True
        if folder_name.startswith(token):
            return True
        if digits_only.startswith(token):
            return True
    return False


def pick_search_roots(
    autorizados_dir: Path,
    doc_type: str,
    full_tokens: set[str],
    short_tokens: set[str],
) -> List[Path]:
    try:
        child_dirs = [item for item in autorizados_dir.iterdir() if item.is_dir()]
    except OSError:
        return []

    token_set = full_tokens if doc_type == "NF-e" else (full_tokens | short_tokens)

    selected = [
        child for child in child_dirs if folder_matches_any_token(child.name, token_set)
    ]

    return sorted(selected, key=lambda item: item.name)


def find_cnpj_dirs(source_dir: Path) -> List[Path]:
    cnpj_dirs = []
    try:
        for entry in source_dir.iterdir():
            if entry.is_dir() and CNPJ_RE.match(entry.name):
                cnpj_dirs.append(entry)
    except OSError:
        return []

    return sorted(cnpj_dirs, key=lambda path: path.name)


def resolve_base_path(raw_value: str) -> Path:
    path = Path(raw_value.strip().strip('"')).expanduser()
    lower_name = path.name.lower()
    if lower_name in {"uninfe", "uninfce", "unicte", "cte"}:
        return path.parent
    return path


def discover_sources(base_dir: Path) -> List[Tuple[str, Path]]:
    sources: List[Tuple[str, Path]] = []

    nfe_dir = base_dir / "UniNFe"
    if nfe_dir.exists():
        sources.append(("NF-e", nfe_dir))

    nfce_dir = base_dir / "Uninfce"
    if nfce_dir.exists():
        sources.append(("NFC-e", nfce_dir))

    for candidate in CTE_DIR_CANDIDATES:
        cte_dir = base_dir / candidate
        if cte_dir.exists():
            sources.append(("CT-e", cte_dir))
            break

    return sources


def validate_structure(base_dir: Path) -> Tuple[bool, List[str]]:
    lines: List[str] = []
    ok = True

    if not base_dir.exists():
        return False, [f"[ERRO] Pasta nao encontrada: {base_dir}"]
    if not base_dir.is_dir():
        return False, [f"[ERRO] Caminho nao e pasta: {base_dir}"]

    expected = [
        ("NF-e", base_dir / "UniNFe", True),
        ("NFC-e", base_dir / "Uninfce", True),
    ]

    cte_path = None
    for candidate in CTE_DIR_CANDIDATES:
        check_path = base_dir / candidate
        if check_path.exists():
            cte_path = check_path
            break
    if cte_path is not None:
        expected.append(("CT-e", cte_path, False))

    for doc_type, source_path, required in expected:
        if not source_path.exists():
            if required:
                ok = False
                lines.append(f"[ERRO] Pasta obrigatoria ausente para {doc_type}: {source_path.name}")
            else:
                lines.append(f"[INFO] Pasta opcional ausente para {doc_type}: {source_path.name}")
            continue

        cnpj_dirs = find_cnpj_dirs(source_path)
        if not cnpj_dirs:
            message = f"[AVISO] Nenhum CNPJ (14 digitos) encontrado em {source_path.name}"
            if required:
                ok = False
                message = f"[ERRO] {message[8:]}"
            lines.append(message)
            continue

        valid_autorizados = 0
        for cnpj_dir in cnpj_dirs:
            if (cnpj_dir / "Enviado" / "Autorizados").exists():
                valid_autorizados += 1

        if valid_autorizados == 0:
            if required:
                ok = False
                lines.append(
                    f"[ERRO] CNPJs em {source_path.name}, mas sem estrutura Enviado/Autorizados."
                )
            else:
                lines.append(
                    f"[AVISO] CNPJs em {source_path.name}, mas sem estrutura Enviado/Autorizados."
                )
        else:
            lines.append(
                f"[OK] {doc_type}: {len(cnpj_dirs)} CNPJ(s), {valid_autorizados} com Enviado/Autorizados."
            )

    if not lines:
        lines.append("[ERRO] Nenhuma pasta valida encontrada na raiz.")

    return ok, lines

def iter_xml_files(root_dir: Path):
    for current_root, _dirs, files in os.walk(root_dir):
        if not files:
            continue
        base_path = Path(current_root)
        for file_name in files:
            if file_name.lower().endswith(".xml"):
                yield base_path / file_name



def scan_notes(
    base_dir: Path,
    start_date: date,
    end_date: date,
    progress_callback: Optional[Callable[[str], None]] = None,
) -> Tuple[List[NoteRecord], Dict[str, int]]:
    full_tokens, short_tokens = month_tokens_between(start_date, end_date)
    all_notes: List[NoteRecord] = []

    stats = {
        "cnpjs": 0,
        "xml_lidos": 0,
        "notas_no_periodo": 0,
    }

    def notify(message: str) -> None:
        if progress_callback is not None:
            progress_callback(message)

    for doc_type, source_dir in discover_sources(base_dir):
        cnpj_dirs = find_cnpj_dirs(source_dir)
        stats["cnpjs"] += len(cnpj_dirs)
        notify(f"[{doc_type}] {len(cnpj_dirs)} CNPJ(s) encontrados.")

        for index, cnpj_dir in enumerate(cnpj_dirs, start=1):
            autorizados_dir = cnpj_dir / "Enviado" / "Autorizados"
            if not autorizados_dir.exists():
                continue

            search_roots = pick_search_roots(autorizados_dir, doc_type, full_tokens, short_tokens)
            if not search_roots:
                continue

            notify(
                f"[{doc_type}] CNPJ {cnpj_dir.name} ({index}/{len(cnpj_dirs)}) "
                f"- pastas do periodo: {len(search_roots)}"
            )

            for search_root in search_roots:
                notify(f"[{doc_type}] -> varrendo: {search_root}")
                xmls_na_pasta = 0
                notas_na_pasta = 0

                for xml_path in iter_xml_files(search_root):
                    xmls_na_pasta += 1
                    stats["xml_lidos"] += 1
                    if stats["xml_lidos"] % 500 == 0:
                        notify(f"Lendo XMLs... {stats['xml_lidos']} arquivo(s) processados")

                    note = parse_note_from_xml(xml_path, doc_type, cnpj_dir.name)
                    if note is None:
                        continue

                    note_date = note.issue_date
                    if note_date is None:
                        try:
                            note_date = datetime.fromtimestamp(xml_path.stat().st_mtime).date()
                        except OSError:
                            continue
                        note.issue_date = note_date

                    if start_date <= note_date <= end_date:
                        all_notes.append(note)
                        notas_na_pasta += 1

                notify(
                    f"[{doc_type}] <- concluido {search_root.name}: "
                    f"{xmls_na_pasta} XML(s), {notas_na_pasta} nota(s) no periodo"
                )
    deduped = deduplicate_records(all_notes)
    stats["notas_no_periodo"] = len(deduped)
    notify(
        f"Leitura finalizada. XMLs lidos: {stats['xml_lidos']}. "
        f"Notas no periodo: {stats['notas_no_periodo']}."
    )
    return deduped, stats


def config_file_path() -> Path:
    appdata = os.getenv("APPDATA")
    if appdata:
        config_dir = Path(appdata) / CONFIG_DIR_NAME
    else:
        config_dir = Path.home() / f".{CONFIG_DIR_NAME.lower()}"

    config_dir.mkdir(parents=True, exist_ok=True)
    return config_dir / CONFIG_FILE_NAME


def load_config() -> Dict[str, str]:
    path = config_file_path()
    if not path.exists():
        return {}

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_config(config: Dict[str, str]) -> None:
    path = config_file_path()
    path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")



def resource_path(file_name: str) -> Path:
    if hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / file_name
    return Path(__file__).resolve().parent / file_name

def list_available_drives() -> List[str]:
    drives = []
    for letter in string.ascii_uppercase:
        if Path(f"{letter}:/").exists():
            drives.append(letter)
    return drives


def iter_default_base_candidates() -> List[Path]:
    candidates: List[Path] = []
    drives = list_available_drives()

    for letter in drives:
        candidates.append(Path(f"{letter}:/Unimake"))

    for letter in drives:
        candidates.append(Path(f"{letter}:/"))

    unique: List[Path] = []
    seen = set()
    for candidate in candidates:
        key = str(candidate).lower()
        if key in seen:
            continue
        seen.add(key)
        if candidate.exists() and candidate.is_dir():
            unique.append(candidate)

    return unique


def count_valid_cnpj_dirs(source_dir: Path) -> int:
    valid_count = 0
    for cnpj_dir in find_cnpj_dirs(source_dir):
        if (cnpj_dir / "Enviado" / "Autorizados").exists():
            valid_count += 1
    return valid_count


def score_base_candidate(base_dir: Path) -> int:
    if not base_dir.exists() or not base_dir.is_dir():
        return -1

    score = 0
    nfe_dir = base_dir / "UniNFe"
    nfce_dir = base_dir / "Uninfce"

    if nfe_dir.exists():
        score += 5 + min(count_valid_cnpj_dirs(nfe_dir), 20)

    if nfce_dir.exists():
        score += 5 + min(count_valid_cnpj_dirs(nfce_dir), 20)

    for candidate in CTE_DIR_CANDIDATES:
        if (base_dir / candidate).exists():
            score += 2
            break

    return score


def discover_base_candidates() -> List[Tuple[Path, int]]:
    scored: List[Tuple[Path, int]] = []
    for candidate in iter_default_base_candidates():
        score = score_base_candidate(candidate)
        if score > 0:
            scored.append((candidate, score))

    scored.sort(key=lambda item: item[1], reverse=True)
    return scored

def iter_danfe_ini_candidates() -> List[Path]:
    drives = list_available_drives()
    ordered_drives: List[str] = []

    if "C" in drives:
        ordered_drives.append("C")
    ordered_drives.extend(letter for letter in drives if letter != "C")

    return [Path(f"{letter}:/") / DANFE_INI_RELATIVE_PATH for letter in ordered_drives]


def read_pasta_uninfe_from_danfe_ini(ini_path: Path) -> Optional[str]:
    content = ""
    for encoding in ("utf-8", "cp1252", "latin-1"):
        try:
            content = ini_path.read_text(encoding=encoding)
            break
        except UnicodeDecodeError:
            continue
        except OSError:
            return None

    if not content:
        return None

    for line in content.splitlines():
        match = PASTA_UNINFE_LINE_RE.match(line)
        if match:
            value = match.group(1).strip().strip('"').strip("'")
            return value or None

    return None


def expand_uninfe_base_candidates(raw_path: str) -> List[Path]:
    raw_value = (raw_path or "").strip().strip('"').strip("'")
    if not raw_value:
        return []

    candidate_raw_values = [raw_value]
    remote_match = REMOTE_HOST_DRIVE_RE.match(raw_value)
    if remote_match:
        host = remote_match.group(1)
        drive_letter = remote_match.group(2).upper()
        tail = remote_match.group(3).strip().lstrip("\\/")
        if tail:
            candidate_raw_values.append(f"\\\\{host}\\{drive_letter}$\\{tail}")
            candidate_raw_values.append(f"\\\\{host}\\{tail}")
        else:
            candidate_raw_values.append(f"\\\\{host}\\{drive_letter}$")

    resolved_candidates: List[Path] = []
    seen = set()
    for candidate_raw in candidate_raw_values:
        try:
            base_candidate = resolve_base_path(candidate_raw)
        except Exception:
            continue

        key = str(base_candidate).lower()
        if key in seen:
            continue
        seen.add(key)
        resolved_candidates.append(base_candidate)

    return resolved_candidates


def discover_base_from_danfe_ini() -> Tuple[Optional[Path], List[str]]:
    lines: List[str] = []
    ini_candidates = [path for path in iter_danfe_ini_candidates() if path.exists()]

    if not ini_candidates:
        lines.append("[INFO] DANFE.ini nao encontrado nos caminhos padrao de ControlGas.")
        return None, lines

    fallback_candidate: Optional[Path] = None
    for ini_path in ini_candidates:
        lines.append(f"[OK] DANFE.ini encontrado: {ini_path}")
        configured_path = read_pasta_uninfe_from_danfe_ini(ini_path)
        if not configured_path:
            lines.append("[AVISO] Chave PastaUniNFE nao encontrada no DANFE.ini.")
            continue

        lines.append(f"[INFO] PastaUniNFE lida: {configured_path}")
        for base_candidate in expand_uninfe_base_candidates(configured_path):
            lines.append(f"[INFO] Testando caminho candidato: {base_candidate}")
            try:
                if not base_candidate.exists() or not base_candidate.is_dir():
                    lines.append(f"[AVISO] Caminho nao acessivel: {base_candidate}")
                    continue
            except OSError as exc:
                lines.append(f"[AVISO] Erro ao acessar caminho {base_candidate}: {exc}")
                continue

            if fallback_candidate is None:
                fallback_candidate = base_candidate

            ok, _ = validate_structure(base_candidate)
            if ok:
                lines.append(f"[OK] Estrutura valida via DANFE.ini: {base_candidate}")
                return base_candidate, lines

            lines.append(f"[AVISO] Estrutura incompleta em {base_candidate}.")

    if fallback_candidate is not None:
        lines.append(
            "[INFO] Usando caminho encontrado no DANFE.ini com estrutura parcial (revise no teste)."
        )
        return fallback_candidate, lines

    lines.append("[INFO] Nenhum caminho valido foi encontrado a partir do DANFE.ini.")
    return None, lines

class CalendarPopup(tk.Toplevel):
    def __init__(
        self,
        parent: tk.Widget,
        initial_date: date,
        on_select: Callable[[Optional[date]], None],
    ) -> None:
        super().__init__(parent)
        self.on_select = on_select
        self.selected_date = initial_date
        self.view_year = initial_date.year
        self.view_month = initial_date.month
        self.calendar_data = calendar.Calendar(firstweekday=6)

        self.title("Selecionar data")
        self.resizable(False, False)
        self.transient(parent.winfo_toplevel())

        self.month_label_var = tk.StringVar()
        self.day_buttons: List[tk.Button] = []
        self.default_day_bg = ""
        self.default_day_fg = ""

        self._build_ui()
        self._refresh_days()

        self.protocol("WM_DELETE_WINDOW", self._close)
        self.grab_set()

    def _build_ui(self) -> None:
        container = ttk.Frame(self, padding=8)
        container.pack(fill="both", expand=True)

        nav = ttk.Frame(container)
        nav.pack(fill="x", pady=(0, 6))

        ttk.Button(nav, text="<", width=3, command=self._prev_month).pack(side="left")
        ttk.Label(nav, textvariable=self.month_label_var, anchor="center").pack(
            side="left", fill="x", expand=True
        )
        ttk.Button(nav, text=">", width=3, command=self._next_month).pack(side="right")

        week_frame = ttk.Frame(container)
        week_frame.pack(fill="x")
        for idx, day_name in enumerate(WEEKDAY_SHORT_PT):
            ttk.Label(week_frame, text=day_name, width=4, anchor="center").grid(
                row=0, column=idx, padx=1, pady=1
            )

        days_frame = ttk.Frame(container)
        days_frame.pack(fill="x", pady=(2, 6))

        for row in range(6):
            for col in range(7):
                btn = tk.Button(days_frame, width=3, padx=1, pady=1, relief="groove")
                btn.grid(row=row, column=col, padx=1, pady=1)
                self.day_buttons.append(btn)

        self.default_day_bg = self.day_buttons[0].cget("bg")
        self.default_day_fg = self.day_buttons[0].cget("fg")

        footer = ttk.Frame(container)
        footer.pack(fill="x")

        ttk.Button(footer, text="Hoje", command=self._pick_today).pack(side="left", expand=True)
        ttk.Button(footer, text="Limpar", command=self._clear_date).pack(side="right", expand=True)

    def show_near(self, widget: tk.Widget) -> None:
        self.update_idletasks()
        x = widget.winfo_rootx()
        y = widget.winfo_rooty() + widget.winfo_height() + 2
        self.geometry(f"+{x}+{y}")

    def _month_title(self) -> str:
        return f"{MONTH_NAMES_PT[self.view_month - 1]} {self.view_year}"

    def _refresh_days(self) -> None:
        self.month_label_var.set(self._month_title())

        weeks = self.calendar_data.monthdatescalendar(self.view_year, self.view_month)
        days = [day_value for week in weeks for day_value in week]
        while len(days) < 42:
            days.append(days[-1] + timedelta(days=1))

        today = date.today()
        for idx, day_value in enumerate(days[:42]):
            btn = self.day_buttons[idx]
            btn.configure(
                text=str(day_value.day),
                command=lambda d=day_value: self._pick_date(d),
                state="normal",
            )

            fg = self.default_day_fg
            bg = self.default_day_bg

            if day_value.month != self.view_month:
                fg = "#7a7a7a"

            if self.selected_date == day_value:
                bg = "#1f73d2"
                fg = "white"
            elif day_value == today and day_value.month == self.view_month:
                bg = "#dbeafe"

            btn.configure(fg=fg, bg=bg, activebackground=bg)

    def _pick_date(self, picked_date: date) -> None:
        self.on_select(picked_date)
        self.destroy()

    def _pick_today(self) -> None:
        self._pick_date(date.today())

    def _clear_date(self) -> None:
        self.on_select(None)
        self.destroy()

    def _prev_month(self) -> None:
        if self.view_month == 1:
            self.view_month = 12
            self.view_year -= 1
        else:
            self.view_month -= 1
        self._refresh_days()

    def _next_month(self) -> None:
        if self.view_month == 12:
            self.view_month = 1
            self.view_year += 1
        else:
            self.view_month += 1
        self._refresh_days()

    def _close(self) -> None:
        self.destroy()


class DateInput(ttk.Frame):
    def __init__(self, parent: ttk.Widget, initial_date: Optional[date] = None) -> None:
        super().__init__(parent)
        self.value_var = tk.StringVar()

        self.entry = ttk.Entry(self, width=12, textvariable=self.value_var)
        self.entry.pack(side="left")
        ttk.Button(self, text="...", width=3, command=self._open_calendar).pack(
            side="left", padx=(4, 0)
        )

        self.set_date(initial_date)
        self.entry.bind("<FocusOut>", self._normalize_value)

    def set_date(self, selected_date: Optional[date]) -> None:
        self.value_var.set(format_date_br(selected_date))

    def get_date(self) -> date:
        parsed = parse_date_br(self.value_var.get())
        if parsed is None:
            raise ValueError("Data invalida. Use DD/MM/AAAA.")
        return parsed

    def get_date_or_none(self) -> Optional[date]:
        return parse_date_br(self.value_var.get())

    def _normalize_value(self, _event: tk.Event) -> None:
        parsed = parse_date_br(self.value_var.get())
        if parsed is not None:
            self.value_var.set(format_date_br(parsed))

    def _open_calendar(self) -> None:
        current_date = self.get_date_or_none() or date.today()
        popup = CalendarPopup(self, current_date, self._on_calendar_selected)
        popup.show_near(self.entry)

    def _on_calendar_selected(self, selected_date: Optional[date]) -> None:
        self.set_date(selected_date)


class XmlExplorerApp(tk.Tk):
    CHECKED = "[x]"
    UNCHECKED = "[ ]"
    PARTIAL = "[-]"

    def __init__(self) -> None:
        super().__init__()
        self.title(APP_TITLE)
        self._configure_window_icon()
        self.geometry("1400x880")
        self.minsize(1100, 700)

        self.config_data = load_config()
        self.base_path_var = tk.StringVar()
        self.filter_var = tk.StringVar()
        self.status_var = tk.StringVar(value="Pronto.")

        self.all_notes: List[NoteRecord] = []
        self.note_id_to_record: Dict[Tuple[str, str, str], NoteRecord] = {}
        self.selected_note_ids: set[Tuple[str, str, str]] = set()
        self.visible_note_ids: set[Tuple[str, str, str]] = set()
        self.visible_cnpj_to_note_ids: Dict[str, set[Tuple[str, str, str]]] = {}
        self.expanded_cnpjs: set[str] = set()

        self.item_to_note: Dict[str, NoteRecord] = {}
        self.context_note: Optional[NoteRecord] = None
        self.parent_item_to_cnpj: Dict[str, str] = {}

        self.select_all_var = tk.IntVar(value=0)
        self.selection_count_var = tk.StringVar(value="0 marcado(s)")

        self.start_picker: DateInput
        self.end_picker: DateInput
        self.log_text: tk.Text
        self.tree: ttk.Treeview
        self.content_pane: ttk.Panedwindow

        self._build_layout()
        self._load_defaults()
        self.filter_var.trace_add("write", self._on_filter_changed)
        self._update_selection_indicators()

    def _configure_window_icon(self) -> None:
        if os.name == "nt":
            try:
                import ctypes

                ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
                    "gerenciador.xml.app"
                )
            except Exception:
                pass

        ico_path = resource_path(ICON_ICO_NAME)
        if ico_path.exists():
            try:
                self.iconbitmap(default=str(ico_path))
            except Exception:
                pass



    def _build_layout(self) -> None:
        root = ttk.Frame(self, padding=10)
        root.pack(fill="both", expand=True)

        config_frame = ttk.LabelFrame(root, text="Configuracao")
        config_frame.pack(fill="x", pady=(0, 8))

        ttk.Label(config_frame, text="Pasta base (onde ficam UniNFe / Uninfce):").grid(
            row=0, column=0, padx=(8, 6), pady=8, sticky="w"
        )
        base_entry = ttk.Entry(config_frame, textvariable=self.base_path_var, width=95)
        base_entry.grid(row=0, column=1, padx=(0, 6), pady=8, sticky="ew")
        base_entry.bind("<FocusOut>", lambda _event: self._persist_config())
        base_entry.bind("<Return>", lambda _event: self._persist_config())

        ttk.Button(config_frame, text="Procurar", command=self._on_browse).grid(
            row=0, column=2, padx=4, pady=8
        )
        ttk.Button(config_frame, text="Salvar", command=self._persist_config).grid(
            row=0, column=3, padx=4, pady=8
        )
        ttk.Button(config_frame, text="Buscar DANFE.ini", command=self._on_find_from_danfe).grid(
            row=0, column=4, padx=4, pady=8
        )
        ttk.Button(config_frame, text="Testar estrutura", command=self._on_test_structure).grid(
            row=0, column=5, padx=(4, 8), pady=8
        )
        config_frame.columnconfigure(1, weight=1)

        controls_frame = ttk.LabelFrame(root, text="Periodo e filtros")
        controls_frame.pack(fill="x", pady=(0, 8))

        ttk.Label(controls_frame, text="Data inicial").grid(
            row=0, column=0, padx=(8, 6), pady=8, sticky="w"
        )
        self.start_picker = DateInput(controls_frame)
        self.start_picker.grid(row=0, column=1, padx=(0, 12), pady=8, sticky="w")

        ttk.Label(controls_frame, text="Data final").grid(
            row=0, column=2, padx=(0, 6), pady=8, sticky="w"
        )
        self.end_picker = DateInput(controls_frame)
        self.end_picker.grid(row=0, column=3, padx=(0, 16), pady=8, sticky="w")

        ttk.Button(controls_frame, text="Mes anterior", command=self._use_previous_month).grid(
            row=0, column=4, padx=(0, 10), pady=8
        )
        ttk.Button(controls_frame, text="Buscar XMLs", command=self._on_scan).grid(
            row=0, column=5, padx=(0, 20), pady=8
        )

        ttk.Label(controls_frame, text="Filtro numero doc:").grid(
            row=0, column=6, padx=(0, 6), pady=8, sticky="e"
        )
        ttk.Entry(controls_frame, textvariable=self.filter_var, width=16).grid(
            row=0, column=7, padx=(0, 6), pady=8
        )
        ttk.Button(controls_frame, text="Limpar", command=self._clear_filter).grid(
            row=0, column=8, padx=(0, 8), pady=8
        )

        ttk.Checkbutton(
            controls_frame,
            text="Marcar todos visiveis",
            variable=self.select_all_var,
            command=self._on_toggle_select_all_check,
        ).grid(row=0, column=9, padx=(0, 8), pady=8)

        ttk.Button(
            controls_frame,
            text="Salvar marcados (ZIP)",
            command=self._save_selected_notes_zip,
        ).grid(row=0, column=10, padx=(0, 8), pady=8)

        ttk.Label(controls_frame, textvariable=self.selection_count_var).grid(
            row=0, column=11, padx=(0, 6), pady=8, sticky="w"
        )
        controls_frame.columnconfigure(12, weight=1)

        self.content_pane = ttk.Panedwindow(root, orient="vertical")
        self.content_pane.pack(fill="both", expand=True, pady=(0, 8))

        grid_frame = ttk.LabelFrame(
            self.content_pane,
            text="CNPJs e notas (checkbox para marcar, duplo clique para salvar uma nota)",
        )

        columns = ("sel", "tipo", "numero", "serie", "chave", "emissao")
        self.tree = ttk.Treeview(grid_frame, columns=columns, show="tree headings", height=20)
        self.tree.heading("#0", text="CNPJ / Documento")
        self.tree.heading("sel", text=self.UNCHECKED, command=self._toggle_select_all_from_header)
        self.tree.heading("tipo", text="Tipo")
        self.tree.heading("numero", text="Numero")
        self.tree.heading("serie", text="Serie")
        self.tree.heading("chave", text="Chave de acesso")
        self.tree.heading("emissao", text="Emissao")

        self.tree.column("#0", width=300, anchor="w")
        self.tree.column("sel", width=45, anchor="center", stretch=False)
        self.tree.column("tipo", width=70, anchor="center")
        self.tree.column("numero", width=100, anchor="center")
        self.tree.column("serie", width=80, anchor="center")
        self.tree.column("chave", width=390, anchor="w")
        self.tree.column("emissao", width=100, anchor="center")

        y_scroll = ttk.Scrollbar(grid_frame, orient="vertical", command=self.tree.yview)
        x_scroll = ttk.Scrollbar(grid_frame, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=y_scroll.set, xscrollcommand=x_scroll.set)

        self.tree.grid(row=0, column=0, sticky="nsew")
        y_scroll.grid(row=0, column=1, sticky="ns")
        x_scroll.grid(row=1, column=0, sticky="ew")
        grid_frame.rowconfigure(0, weight=1)
        grid_frame.columnconfigure(0, weight=1)

        self.tree.bind("<ButtonRelease-1>", self._on_tree_click)
        self.tree.bind("<Double-1>", self._on_tree_double_click)
        self.tree.bind("<Button-3>", self._on_tree_right_click)
        self.tree.bind("<<TreeviewOpen>>", self._on_tree_open)
        self.tree.bind("<<TreeviewClose>>", self._on_tree_close)

        self.tree_context_menu = tk.Menu(self, tearoff=0)
        self.tree_context_menu.add_command(
            label="Abrir local do arquivo",
            command=self._open_selected_note_location,
        )

        log_frame = ttk.LabelFrame(
            self.content_pane,
            text="Log (arraste a divisao acima para redimensionar)",
        )

        self.log_text = tk.Text(log_frame, wrap="word", state="disabled", font=("Consolas", 10))
        log_scroll = ttk.Scrollbar(log_frame, orient="vertical", command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=log_scroll.set)
        self.log_text.grid(row=0, column=0, sticky="nsew", padx=(8, 0), pady=8)
        log_scroll.grid(row=0, column=1, sticky="ns", padx=(0, 8), pady=8)
        log_frame.rowconfigure(0, weight=1)
        log_frame.columnconfigure(0, weight=1)

        self.content_pane.add(grid_frame, weight=5)
        self.content_pane.add(log_frame, weight=2)

        status_bar = ttk.Label(root, textvariable=self.status_var, anchor="w")
        status_bar.pack(fill="x", pady=(6, 0))

        self.after(250, self._set_default_split)

    def _set_default_split(self) -> None:
        try:
            pane_height = self.content_pane.winfo_height()
            if pane_height > 200:
                self.content_pane.sashpos(0, int(pane_height * 0.74))
        except Exception:
            pass

    def _load_defaults(self) -> None:
        saved_path = self.config_data.get("base_path", "").strip()
        if saved_path:
            self.base_path_var.set(saved_path)
            self._append_log(f"Configuracao carregada: {saved_path}")
        else:
            self._run_first_time_autodetect()

        self._use_previous_month()

    def _run_first_time_autodetect(self) -> None:
        self._append_log("Primeira execucao sem configuracao. Tentando detectar via DANFE.ini...")
        danfe_base, danfe_lines = discover_base_from_danfe_ini()
        for line in danfe_lines:
            self._append_log(line)

        if danfe_base is not None:
            use_found = messagebox.askyesno(
                "Diretorio encontrado (DANFE.ini)",
                "Encontrei uma pasta base da Unimake via DANFE.ini em:\n"
                f"{danfe_base}\n\n"
                "Deseja usar este diretorio?",
            )
            if use_found:
                self.base_path_var.set(str(danfe_base))
                self._persist_config()
                return

            self._append_log("Diretorio via DANFE.ini nao confirmado. Seguindo busca padrao.")

        self._append_log("Buscando diretorios padrao na raiz dos discos...")
        candidates = discover_base_candidates()

        if candidates:
            for candidate_path, candidate_score in candidates[:3]:
                self._append_log(f"Candidato encontrado (score {candidate_score}): {candidate_path}")

            best_path, _best_score = candidates[0]
            use_found = messagebox.askyesno(
                "Diretorio encontrado",
                "Encontrei uma estrutura provavel da Unimake em:\n"
                f"{best_path}\n\n"
                "Deseja usar este diretorio?",
            )
            if use_found:
                self.base_path_var.set(str(best_path))
                self._persist_config()
                return

            self.base_path_var.set(str(Path.cwd()))
            self.after(100, self._ask_user_for_base_path)
            return

        self.base_path_var.set(str(Path.cwd()))
        self._append_log("Nenhum diretorio padrao encontrado automaticamente.")
        self.after(100, self._ask_user_for_base_path)

    def _ask_user_for_base_path(self) -> None:
        selected = filedialog.askdirectory(
            title="Selecione a pasta base (raiz com UniNFe/Uninfce)",
            initialdir=str(Path.cwd()),
        )
        if not selected:
            self._append_log("Diretorio nao selecionado. Mantendo valor atual.")
            return

        resolved = resolve_base_path(selected)
        self.base_path_var.set(str(resolved))
        self._persist_config()

    def _set_status(self, message: str) -> None:
        self.status_var.set(message)

    def _append_log(self, message: str) -> None:
        self.log_text.configure(state="normal")
        self.log_text.insert("end", message.rstrip() + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _note_id(self, note: NoteRecord) -> Tuple[str, str, str]:
        return (note.doc_type, note.cnpj, note.key)

    def _checkbox_marker(self, note_ids: set[Tuple[str, str, str]]) -> str:
        if not note_ids:
            return self.UNCHECKED

        selected_count = len(note_ids & self.selected_note_ids)
        if selected_count == 0:
            return self.UNCHECKED
        if selected_count == len(note_ids):
            return self.CHECKED
        return self.PARTIAL

    def _update_selection_indicators(self) -> None:
        visible_count = len(self.visible_note_ids)
        selected_visible_count = len(self.visible_note_ids & self.selected_note_ids)

        if visible_count > 0 and selected_visible_count == visible_count:
            self.select_all_var.set(1)
        else:
            self.select_all_var.set(0)

        self.selection_count_var.set(f"{len(self.selected_note_ids)} marcado(s)")
        self.tree.heading(
            "sel",
            text=self._checkbox_marker(self.visible_note_ids),
            command=self._toggle_select_all_from_header,
        )

    def _toggle_select_all_from_header(self) -> None:
        if not self.visible_note_ids:
            return

        if self.visible_note_ids.issubset(self.selected_note_ids):
            self.selected_note_ids.difference_update(self.visible_note_ids)
        else:
            self.selected_note_ids.update(self.visible_note_ids)

        self._apply_filter_and_render()

    def _on_toggle_select_all_check(self) -> None:
        if self.select_all_var.get() == 1:
            self.selected_note_ids.update(self.visible_note_ids)
        else:
            self.selected_note_ids.difference_update(self.visible_note_ids)

        self._apply_filter_and_render()

    def _get_date_range(self) -> Tuple[date, date]:
        start_date = self.start_picker.get_date()
        end_date = self.end_picker.get_date()
        if start_date > end_date:
            raise ValueError("Data inicial nao pode ser maior que data final.")
        return start_date, end_date

    def _resolve_base_dir(self, require_exists: bool = True) -> Optional[Path]:
        raw_text = self.base_path_var.get().strip()
        if not raw_text:
            messagebox.showwarning("Atencao", "Informe a pasta base.")
            return None

        resolved = resolve_base_path(raw_text)
        self.base_path_var.set(str(resolved))
        if require_exists and not resolved.exists():
            messagebox.showerror("Erro", f"Pasta nao encontrada:\n{resolved}")
            return None

        return resolved

    def _persist_config(self) -> None:
        base_dir = self._resolve_base_dir(require_exists=False)
        if base_dir is None:
            return

        self.config_data["base_path"] = str(base_dir)
        try:
            save_config(self.config_data)
            self._set_status("Configuracao salva.")
        except Exception as exc:
            self._append_log(f"[ERRO] Falha ao salvar configuracao: {exc}")
            self._set_status("Falha ao salvar configuracao.")

    def _on_browse(self) -> None:
        initial_dir = self.base_path_var.get().strip() or str(Path.cwd())
        selected = filedialog.askdirectory(
            title="Selecione a pasta base (raiz onde ficam UniNFe/Uninfce)",
            initialdir=initial_dir,
        )
        if not selected:
            return

        resolved = resolve_base_path(selected)
        self.base_path_var.set(str(resolved))
        self._persist_config()

    def _on_find_from_danfe(self) -> None:
        self._append_log("-" * 80)
        self._append_log("Buscando pasta base via DANFE.ini...")

        base_dir, lines = discover_base_from_danfe_ini()
        for line in lines:
            self._append_log(line)

        if base_dir is None:
            self._set_status("DANFE.ini nao localizado.")
            messagebox.showwarning(
                "DANFE.ini nao encontrado",
                "Nao foi possivel obter a pasta da Unimake pelo DANFE.ini."
                "\nInforme manualmente em Procurar.",
            )
            return

        self.base_path_var.set(str(base_dir))
        self._persist_config()

        ok, _ = validate_structure(base_dir)
        if ok:
            self._set_status("Pasta base definida via DANFE.ini.")
            messagebox.showinfo(
                "Diretorio definido",
                f"Pasta base definida via DANFE.ini:\n{base_dir}",
            )
        else:
            self._set_status("Pasta via DANFE.ini definida com avisos de estrutura.")
            messagebox.showwarning(
                "Diretorio definido com avisos",
                "A pasta foi localizada via DANFE.ini, mas a estrutura parece incompleta."
                "\nUse Testar estrutura para detalhes.",
            )

    def _on_test_structure(self) -> None:
        base_dir = self._resolve_base_dir(require_exists=True)
        if base_dir is None:
            return

        ok, lines = validate_structure(base_dir)
        self._append_log("-" * 80)
        self._append_log(f"Teste de estrutura em: {base_dir}")
        for line in lines:
            self._append_log(line)

        if ok:
            messagebox.showinfo("Teste concluido", "Estrutura validada com sucesso.")
            self._set_status("Estrutura valida.")
        else:
            messagebox.showwarning(
                "Teste concluido",
                "Foram encontrados problemas na estrutura. Veja o log.",
            )
            self._set_status("Estrutura com problemas.")

        self._persist_config()

    def _use_previous_month(self) -> None:
        today = date.today()
        first_current_month = today.replace(day=1)
        last_previous_month = first_current_month - timedelta(days=1)
        first_previous_month = last_previous_month.replace(day=1)

        self.start_picker.set_date(first_previous_month)
        self.end_picker.set_date(last_previous_month)

    def _on_scan(self) -> None:
        base_dir = self._resolve_base_dir(require_exists=True)
        if base_dir is None:
            return

        try:
            start_date, end_date = self._get_date_range()
        except ValueError as exc:
            messagebox.showwarning("Datas invalidas", str(exc))
            return

        self._persist_config()
        self._set_status("Lendo XMLs...")
        self.update_idletasks()

        last_status_update = 0.0
        last_log_update = 0.0
        last_log_message = ""

        def on_progress(message: str) -> None:
            nonlocal last_status_update, last_log_update, last_log_message
            now = time.monotonic()
            important = message.startswith("[") or message.startswith("Leitura finalizada")

            if important:
                if message != last_log_message:
                    self._append_log(message)
                    last_log_message = message
            elif now - last_log_update >= 1.2:
                self._append_log(message)
                last_log_update = now

            if important or now - last_status_update >= 0.15:
                self._set_status(message)
                self.update_idletasks()
                last_status_update = now

        try:
            notes, stats = scan_notes(
                base_dir,
                start_date,
                end_date,
                progress_callback=on_progress,
            )
        except Exception as exc:
            messagebox.showerror("Erro na busca", f"Ocorreu um erro ao varrer os XMLs:\n{exc}")
            self._append_log(f"[ERRO] Falha ao varrer XMLs: {exc}")
            self._set_status("Falha na busca.")
            return

        self.all_notes = notes
        self.note_id_to_record = {self._note_id(note): note for note in notes}
        self.selected_note_ids = {
            note_id for note_id in self.selected_note_ids if note_id in self.note_id_to_record
        }

        self._apply_filter_and_render()

        self._append_log("-" * 80)
        self._append_log(
            f"Busca concluida: {start_date.isoformat()} ate {end_date.isoformat()}"
        )
        self._append_log(f"CNPJs analisados: {stats['cnpjs']}")
        self._append_log(f"Arquivos XML lidos: {stats['xml_lidos']}")
        self._append_log(f"Notas unicas encontradas no periodo: {stats['notas_no_periodo']}")
        self._set_status(
            f"{len(self.all_notes)} nota(s) encontrada(s). {len(self.selected_note_ids)} marcada(s)."
        )

    def _snapshot_expanded_cnpjs(self) -> None:
        expanded: set[str] = set()
        for parent_item in self.tree.get_children(""):
            if self.tree.item(parent_item, "open"):
                cnpj = self.parent_item_to_cnpj.get(parent_item)
                if cnpj is not None:
                    expanded.add(cnpj)
        self.expanded_cnpjs = expanded

    def _filter_notes(self, notes: List[NoteRecord]) -> List[NoteRecord]:
        needle = self.filter_var.get().strip()
        if not needle:
            return notes

        return [note for note in notes if needle in note.number]

    def _apply_filter_and_render(self) -> None:
        self._snapshot_expanded_cnpjs()
        filtered_notes = self._filter_notes(self.all_notes)
        self._render_tree(filtered_notes)
        self._update_selection_indicators()
        self._set_status(
            f"{len(filtered_notes)} nota(s) visivel(is) de {len(self.all_notes)} total. "
            f"{len(self.selected_note_ids)} marcada(s)."
        )

    def _clear_filter(self) -> None:
        self.filter_var.set("")

    def _on_filter_changed(self, *_args: object) -> None:
        self._apply_filter_and_render()

    def _render_tree(self, notes: List[NoteRecord]) -> None:
        self.tree.delete(*self.tree.get_children())

        self.item_to_note.clear()
        self.parent_item_to_cnpj.clear()
        self.visible_cnpj_to_note_ids.clear()
        self.visible_note_ids.clear()

        grouped: Dict[str, List[NoteRecord]] = {}
        for note in notes:
            grouped.setdefault(note.cnpj, []).append(note)

        for cnpj in sorted(grouped.keys()):
            notes_by_cnpj = sorted(
                grouped[cnpj],
                key=lambda r: (
                    r.issue_date or date.min,
                    r.doc_type,
                    int(r.number) if r.number.isdigit() else 0,
                    r.key,
                ),
            )

            cnpj_note_ids = {self._note_id(note) for note in notes_by_cnpj}
            self.visible_cnpj_to_note_ids[cnpj] = cnpj_note_ids
            self.visible_note_ids.update(cnpj_note_ids)

            parent_item = self.tree.insert(
                "",
                "end",
                text=f"{cnpj} ({len(notes_by_cnpj)} nota(s))",
                values=(self._checkbox_marker(cnpj_note_ids), "", "", "", "", ""),
                open=(cnpj in self.expanded_cnpjs),
            )
            self.parent_item_to_cnpj[parent_item] = cnpj

            for note in notes_by_cnpj:
                note_id = self._note_id(note)
                issue_text = note.issue_date.isoformat() if note.issue_date else "-"
                child_item = self.tree.insert(
                    parent_item,
                    "end",
                    text=f"{note.doc_type} {note.number}",
                    values=(
                        self.CHECKED if note_id in self.selected_note_ids else self.UNCHECKED,
                        note.doc_type,
                        note.number,
                        note.series,
                        note.key,
                        issue_text,
                    ),
                )
                self.item_to_note[child_item] = note

    def _on_tree_open(self, _event: tk.Event) -> None:
        item_id = self.tree.focus()
        cnpj = self.parent_item_to_cnpj.get(item_id)
        if cnpj is not None:
            self.expanded_cnpjs.add(cnpj)

    def _on_tree_close(self, _event: tk.Event) -> None:
        item_id = self.tree.focus()
        cnpj = self.parent_item_to_cnpj.get(item_id)
        if cnpj is not None:
            self.expanded_cnpjs.discard(cnpj)

    def _on_tree_right_click(self, event: tk.Event) -> None:
        row_id = self.tree.identify_row(event.y)
        if not row_id:
            return

        note = self.item_to_note.get(row_id)
        if note is None:
            return

        self.tree.selection_set(row_id)
        self.tree.focus(row_id)
        self.context_note = note

        try:
            self.tree_context_menu.tk_popup(event.x_root, event.y_root)
        finally:
            self.tree_context_menu.grab_release()

    def _open_selected_note_location(self) -> None:
        note = self.context_note
        if note is None:
            row_id = self.tree.focus()
            note = self.item_to_note.get(row_id)
        if note is None:
            return

        source = note.file_path
        if not source.exists():
            messagebox.showwarning("Arquivo nao encontrado", f"Arquivo nao encontrado:\n{source}")
            return

        try:
            if os.name == "nt":
                subprocess.run(["explorer", "/select,", str(source)], check=False)
            else:
                subprocess.run(["xdg-open", str(source.parent)], check=False)
        except Exception as exc:
            messagebox.showerror("Erro", f"Nao foi possivel abrir o local do arquivo:\n{exc}")

    def _on_tree_click(self, event: tk.Event) -> None:
        row_id = self.tree.identify_row(event.y)
        col_id = self.tree.identify_column(event.x)
        if not row_id or col_id != "#1":
            return

        cnpj = self.parent_item_to_cnpj.get(row_id)
        if cnpj is not None:
            note_ids = self.visible_cnpj_to_note_ids.get(cnpj, set())
            if not note_ids:
                return
            if note_ids.issubset(self.selected_note_ids):
                self.selected_note_ids.difference_update(note_ids)
            else:
                self.selected_note_ids.update(note_ids)
            self._apply_filter_and_render()
            return

        note = self.item_to_note.get(row_id)
        if note is None:
            return

        note_id = self._note_id(note)
        if note_id in self.selected_note_ids:
            self.selected_note_ids.remove(note_id)
        else:
            self.selected_note_ids.add(note_id)

        self._apply_filter_and_render()

    def _on_tree_double_click(self, event: tk.Event) -> None:
        row_id = self.tree.identify_row(event.y)
        col_id = self.tree.identify_column(event.x)
        if not row_id or col_id == "#1":
            return

        note = self.item_to_note.get(row_id)
        if note is None:
            return

        self._save_note_copy(note)

    def _format_period_for_zip_name(self, start_date: date, end_date: date) -> str:
        if start_date.year == end_date.year and start_date.month == end_date.month:
            month_name = MONTH_NAMES_PT[start_date.month - 1].capitalize()
            last_day = calendar.monthrange(start_date.year, start_date.month)[1]

            if start_date.day == 1 and end_date.day == last_day:
                return f"XML {month_name} {start_date.year}"
            if start_date.day == end_date.day:
                return f"XML {start_date.day:02d} {month_name} {start_date.year}"

            return f"XML {start_date.day:02d}-{end_date.day:02d} {month_name} {start_date.year}"

        if start_date.year == end_date.year:
            return (
                f"XML {start_date.day:02d}-{start_date.month:02d} a "
                f"{end_date.day:02d}-{end_date.month:02d}"
            )

        return (
            f"XML {start_date.day:02d}-{start_date.month:02d}-{start_date.year} a "
            f"{end_date.day:02d}-{end_date.month:02d}-{end_date.year}"
        )

    def _build_default_zip_name(self) -> str:
        try:
            start_date, end_date = self._get_date_range()
        except ValueError:
            return f"XMLs_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"

        return f"{self._format_period_for_zip_name(start_date, end_date)}.zip"


    def _save_selected_notes_zip(self) -> None:
        selected_notes = [
            self.note_id_to_record[note_id]
            for note_id in sorted(self.selected_note_ids)
            if note_id in self.note_id_to_record
        ]

        if not selected_notes:
            messagebox.showwarning("Nenhum XML marcado", "Marque pelo menos um XML para salvar.")
            return

        default_name = self._build_default_zip_name()
        zip_target = filedialog.asksaveasfilename(
            title="Salvar XMLs marcados",
            defaultextension=".zip",
            initialfile=default_name,
            filetypes=[("Arquivo ZIP", "*.zip")],
        )
        if not zip_target:
            return

        added = 0
        missing = 0
        used_names: set[str] = set()

        try:
            with zipfile.ZipFile(zip_target, mode="w", compression=zipfile.ZIP_DEFLATED) as zip_file:
                for note in selected_notes:
                    source = note.file_path
                    if not source.exists():
                        missing += 1
                        continue

                    folder_doc = note.doc_type.replace(" ", "").replace("-", "")
                    arc_name = f"{note.cnpj}/{folder_doc}/{source.name}"

                    if arc_name in used_names:
                        stem = source.stem
                        suffix = source.suffix or ".xml"
                        idx = 2
                        while True:
                            candidate = f"{note.cnpj}/{folder_doc}/{stem}_{idx}{suffix}"
                            if candidate not in used_names:
                                arc_name = candidate
                                break
                            idx += 1

                    used_names.add(arc_name)
                    zip_file.write(source, arcname=arc_name)
                    added += 1
        except Exception as exc:
            messagebox.showerror("Erro ao salvar ZIP", f"Falha ao gerar arquivo ZIP:\n{exc}")
            self._append_log(f"[ERRO] Falha ao gerar ZIP {zip_target}: {exc}")
            self._set_status("Falha ao gerar ZIP.")
            return

        if added == 0:
            try:
                Path(zip_target).unlink(missing_ok=True)
            except OSError:
                pass
            messagebox.showwarning("Nenhum XML salvo", "Nenhum XML valido foi encontrado para compactar.")
            self._set_status("Nenhum XML foi salvo.")
            return

        info_message = f"ZIP salvo com {added} XML(s):\n{zip_target}"
        if missing > 0:
            info_message += f"\nXML(s) ignorados (nao encontrados): {missing}"

        messagebox.showinfo("ZIP gerado", info_message)
        self._append_log(info_message)
        self._set_status(f"ZIP gerado com {added} XML(s).")

    def _save_note_copy(self, note: NoteRecord) -> None:
        default_name = f"{note.doc_type.replace('-', '').replace(' ', '')}_{note.key}.xml"
        save_target = filedialog.asksaveasfilename(
            title="Salvar copia do XML",
            defaultextension=".xml",
            initialfile=default_name,
            filetypes=[("Arquivo XML", "*.xml"), ("Todos os arquivos", "*.*")],
        )
        if not save_target:
            return

        try:
            shutil.copy2(note.file_path, Path(save_target))
        except Exception as exc:
            messagebox.showerror("Erro ao salvar", f"Nao foi possivel salvar o XML:\n{exc}")
            self._append_log(f"[ERRO] Falha ao copiar {note.file_path}: {exc}")
            self._set_status("Falha ao salvar XML.")
            return

        self._append_log(f"XML exportado: {note.file_path} -> {save_target}")
        self._set_status(f"XML salvo em: {save_target}")

def main() -> None:
    app = XmlExplorerApp()
    app.mainloop()


if __name__ == "__main__":
    main()


