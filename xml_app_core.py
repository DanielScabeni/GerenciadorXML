from __future__ import annotations

import calendar
import json
import os
import re
import shutil
import string
import subprocess
import tempfile
import threading
import time
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple
from uuid import uuid4
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
REMOTE_HOST_DRIVE_RE = re.compile(r"^\s*([A-Za-z0-9_.-]+)\s*:\s*([A-Za-z])\s*:[\\/](.*)\s*$")

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


@dataclass
class NoteRecord:
    doc_type: str
    cnpj: str
    key: str
    number: str
    series: str
    issue_date: Optional[date]
    file_path: Path


@dataclass
class ScanJob:
    job_id: str
    status: str = "running"
    progress_text: str = "Preparando leitura..."
    period: Dict[str, str] = field(default_factory=lambda: {
        "startDate": "",
        "endDate": "",
    })
    logs: List[str] = field(default_factory=list)
    stats: Dict[str, int] = field(default_factory=lambda: {
        "cnpjs": 0,
        "xml_lidos": 0,
        "notas_no_periodo": 0,
    })
    notes: List[Dict[str, object]] = field(default_factory=list)
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None

    def to_payload(self) -> Dict[str, object]:
        return {
            "ok": True,
            "jobId": self.job_id,
            "status": self.status,
            "progressText": self.progress_text,
            "period": dict(self.period),
            "logs": list(self.logs),
            "stats": dict(self.stats),
            "notes": list(self.notes),
            "error": self.error,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "completedAt": self.completed_at,
        }


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


def parse_iso_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


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


def pick_search_roots(autorizados_dir: Path, doc_type: str, full_tokens: set[str], short_tokens: set[str]) -> List[Path]:
    try:
        child_dirs = [item for item in autorizados_dir.iterdir() if item.is_dir()]
    except OSError:
        return []

    token_set = full_tokens if doc_type == "NF-e" else (full_tokens | short_tokens)
    selected = [child for child in child_dirs if folder_matches_any_token(child.name, token_set)]
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
                lines.append(f"[ERRO] CNPJs em {source_path.name}, mas sem estrutura Enviado/Autorizados.")
            else:
                lines.append(f"[AVISO] CNPJs em {source_path.name}, mas sem estrutura Enviado/Autorizados.")
        else:
            lines.append(f"[OK] {doc_type}: {len(cnpj_dirs)} CNPJ(s), {valid_autorizados} com Enviado/Autorizados.")

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
                f"[{doc_type}] CNPJ {cnpj_dir.name} ({index}/{len(cnpj_dirs)}) - "
                f"pastas do periodo: {len(search_roots)}"
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


def _fallback_config_dir() -> Path:
    home_dir = Path.home() / f".{CONFIG_DIR_NAME.lower()}"
    try:
        home_dir.mkdir(parents=True, exist_ok=True)
        return home_dir
    except OSError:
        temp_dir = Path(tempfile.gettempdir()) / CONFIG_DIR_NAME
        temp_dir.mkdir(parents=True, exist_ok=True)
        return temp_dir



def config_file_path() -> Path:
    appdata = os.getenv("APPDATA")
    if appdata:
        config_dir = Path(appdata) / CONFIG_DIR_NAME
        try:
            config_dir.mkdir(parents=True, exist_ok=True)
            return config_dir / CONFIG_FILE_NAME
        except OSError:
            pass

    return _fallback_config_dir() / CONFIG_FILE_NAME



def load_config() -> Dict[str, str]:
    try:
        path = config_file_path()
    except OSError:
        return {}

    try:
        if not path.exists():
            return {}
    except OSError:
        return {}

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}



def save_config(config: Dict[str, str]) -> None:
    serialized = json.dumps(config, ensure_ascii=False, indent=2)
    try:
        path = config_file_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(serialized, encoding="utf-8")
        return
    except OSError:
        fallback_path = _fallback_config_dir() / CONFIG_FILE_NAME
        try:
            fallback_path.write_text(serialized, encoding="utf-8")
        except OSError:
            return


def resource_path(file_name: str) -> Path:
    import sys

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
        lines.append("[INFO] Usando caminho encontrado no DANFE.ini com estrutura parcial (revise no teste).")
        return fallback_candidate, lines

    lines.append("[INFO] Nenhum caminho valido foi encontrado a partir do DANFE.ini.")
    return None, lines

def current_month_range(reference: Optional[date] = None) -> Tuple[date, date]:
    base = reference or date.today()
    first_day = base.replace(day=1)
    last_day = base.replace(day=calendar.monthrange(base.year, base.month)[1])
    return first_day, last_day


def previous_month_range(reference: Optional[date] = None) -> Tuple[date, date]:
    base = reference or date.today()
    current_first_day = base.replace(day=1)
    previous_last_day = current_first_day - timedelta(days=1)
    previous_first_day = previous_last_day.replace(day=1)
    return previous_first_day, previous_last_day


def default_period_range(reference: Optional[date] = None) -> Tuple[date, date]:
    return previous_month_range(reference)


def note_identifier(note: NoteRecord) -> str:
    return f"{note.doc_type}|{note.cnpj}|{note.key}"


def serialize_note(note: NoteRecord) -> Dict[str, object]:
    return {
        "id": note_identifier(note),
        "docType": note.doc_type,
        "cnpj": note.cnpj,
        "accessKey": note.key,
        "number": note.number,
        "series": note.series,
        "issueDate": note.issue_date.isoformat() if note.issue_date else None,
        "fileName": note.file_path.name,
    }


def format_period_for_zip_name(start_date: date, end_date: date) -> str:
    if start_date.year == end_date.year and start_date.month == end_date.month:
        month_name = MONTH_NAMES_PT[start_date.month - 1].capitalize()
        last_day = calendar.monthrange(start_date.year, start_date.month)[1]

        if start_date.day == 1 and end_date.day == last_day:
            return f"XML {month_name} {start_date.year}"
        if start_date.day == end_date.day:
            return f"XML {start_date.day:02d} {month_name} {start_date.year}"

        return f"XML {start_date.day:02d}-{end_date.day:02d} {month_name} {start_date.year}"

    if start_date.year == end_date.year:
        return f"XML {start_date.day:02d}-{start_date.month:02d} a {end_date.day:02d}-{end_date.month:02d}"

    return (
        f"XML {start_date.day:02d}-{start_date.month:02d}-{start_date.year} a "
        f"{end_date.day:02d}-{end_date.month:02d}-{end_date.year}"
    )


def build_default_zip_name(start_date: date, end_date: date) -> str:
    return f"{format_period_for_zip_name(start_date, end_date)}.zip"


def format_xml_preview(source: Path) -> str:
    try:
        tree = ET.parse(source)
        root = tree.getroot()
        for element in root.iter():
            if isinstance(element.tag, str) and element.tag.startswith("{"):
                element.tag = element.tag.split("}", 1)[1]

            if element.attrib:
                normalized_attributes = {}
                for key, value in element.attrib.items():
                    normalized_key = key.split("}", 1)[1] if key.startswith("{") else key
                    normalized_attributes[normalized_key] = value
                element.attrib.clear()
                element.attrib.update(normalized_attributes)

        ET.indent(tree, space="  ")
        return ET.tostring(root, encoding="unicode")
    except ET.ParseError:
        for encoding in ("utf-8", "utf-8-sig", "cp1252", "latin-1"):
            try:
                return source.read_text(encoding=encoding)
            except UnicodeDecodeError:
                continue
        return source.read_text(encoding="utf-8", errors="replace")


class XmlAppService:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.config_data = load_config()
        self.note_by_id: Dict[str, NoteRecord] = {}
        self.jobs: Dict[str, ScanJob] = {}

    def _last_search_payload(self) -> Optional[Dict[str, str]]:
        start_date = self.config_data.get("last_search_start_date", "").strip()
        end_date = self.config_data.get("last_search_end_date", "").strip()
        if not start_date or not end_date:
            return None
        return {
            "startDate": start_date,
            "endDate": end_date,
        }

    def get_initial_state(self) -> Dict[str, object]:
        saved_path = self.config_data.get("base_path", "").strip()
        normalized_saved_path = str(resolve_base_path(saved_path)) if saved_path else ""
        start_date, end_date = default_period_range()

        startup = {
            "mode": "loading",
            "shouldPromptConfig": False,
            "title": "Carregando configuracao",
            "message": "Preparando a interface e verificando configuracoes em segundo plano.",
            "path": normalized_saved_path,
            "lines": [],
        }
        return {
            "ok": True,
            "appTitle": APP_TITLE,
            "config": {
                "basePath": normalized_saved_path,
                "hasSavedPath": bool(normalized_saved_path),
            },
            "defaults": {
                "startDate": start_date.isoformat(),
                "endDate": end_date.isoformat(),
            },
            "startup": startup,
            "validation": None,
            "lastSearch": self._last_search_payload(),
        }

    def load_startup_context(self) -> Dict[str, object]:
        saved_path = self.config_data.get("base_path", "").strip()
        normalized_saved_path = str(resolve_base_path(saved_path)) if saved_path else ""

        startup = self._build_startup_payload(normalized_saved_path)
        return {
            "ok": True,
            "config": {
                "basePath": normalized_saved_path,
                "hasSavedPath": bool(normalized_saved_path),
            },
            "startup": startup,
            "validation": None,
            "lastSearch": self._last_search_payload(),
        }

    def _build_startup_payload(self, saved_path: str) -> Dict[str, object]:
        if saved_path:
            return {
                "mode": "saved",
                "shouldPromptConfig": False,
                "title": "Configuracao carregada",
                "message": "Usando o caminho salvo localmente.",
                "path": saved_path,
                "lines": [f"[OK] Configuracao carregada: {saved_path}"],
            }

        base_dir, lines = discover_base_from_danfe_ini()
        if base_dir is not None:
            return {
                "mode": "suggestion",
                "shouldPromptConfig": True,
                "source": "danfe",
                "title": "Diretorio encontrado via DANFE.ini",
                "message": "Encontrei um caminho provavel pelo DANFE.ini. Confirme se deseja usar ou altere manualmente.",
                "path": str(base_dir),
                "lines": lines,
            }

        candidates = discover_base_candidates()
        if candidates:
            best_path, best_score = candidates[0]
            candidate_lines = [f"[INFO] Candidato encontrado (score {best_score}): {best_path}"]
            for candidate_path, candidate_score in candidates[1:3]:
                candidate_lines.append(f"[INFO] Outro candidato (score {candidate_score}): {candidate_path}")
            return {
                "mode": "suggestion",
                "shouldPromptConfig": True,
                "source": "default-search",
                "title": "Diretorio encontrado nos caminhos padrao",
                "message": "Encontrei uma estrutura provavel da Unimake. Confirme se deseja usar ou altere manualmente.",
                "path": str(best_path),
                "lines": candidate_lines,
            }

        return {
            "mode": "manual-required",
            "shouldPromptConfig": True,
            "source": "manual",
            "title": "Configuracao necessaria",
            "message": "Nao foi possivel detectar a pasta base automaticamente. Selecione a pasta da Unimake manualmente.",
            "path": "",
            "lines": ["[INFO] Nenhum diretorio padrao encontrado automaticamente."],
        }

    def save_base_path(self, base_path: str) -> Dict[str, object]:
        resolved = resolve_base_path(base_path)
        with self._lock:
            self.config_data["base_path"] = str(resolved)
            save_config(self.config_data)
        return {
            "ok": True,
            "path": str(resolved),
            "message": "Configuracao salva com sucesso.",
        }

    def detect_from_danfe(self) -> Dict[str, object]:
        base_dir, lines = discover_base_from_danfe_ini()
        if base_dir is None:
            return {
                "ok": False,
                "path": "",
                "source": "danfe",
                "message": "Nao foi possivel localizar a pasta da Unimake pelo DANFE.ini.",
                "lines": lines,
            }

        ok, validation_lines = validate_structure(base_dir)
        return {
            "ok": True,
            "path": str(base_dir),
            "source": "danfe",
            "message": "Diretorio localizado via DANFE.ini.",
            "lines": lines + validation_lines,
            "structureOk": ok,
        }

    def detect_default_base(self) -> Dict[str, object]:
        candidates = discover_base_candidates()
        if not candidates:
            return {
                "ok": False,
                "path": "",
                "source": "default-search",
                "message": "Nenhuma estrutura padrao da Unimake foi localizada nos discos disponiveis.",
                "lines": ["[INFO] Nenhum diretorio padrao encontrado automaticamente."],
            }

        best_path, best_score = candidates[0]
        lines = [f"[INFO] Candidato encontrado (score {best_score}): {best_path}"]
        for candidate_path, candidate_score in candidates[1:3]:
            lines.append(f"[INFO] Outro candidato (score {candidate_score}): {candidate_path}")

        ok, validation_lines = validate_structure(best_path)
        return {
            "ok": True,
            "path": str(best_path),
            "source": "default-search",
            "message": "Diretorio localizado pelos caminhos padrao.",
            "lines": lines + validation_lines,
            "structureOk": ok,
        }

    def test_structure(self, base_path: str, persist: bool = False) -> Dict[str, object]:
        resolved = resolve_base_path(base_path)
        ok, lines = validate_structure(resolved)

        if persist:
            with self._lock:
                self.config_data["base_path"] = str(resolved)
                save_config(self.config_data)

        return {
            "ok": ok,
            "path": str(resolved),
            "lines": lines,
            "message": "Estrutura validada com sucesso." if ok else "Foram encontrados problemas na estrutura.",
        }

    def start_scan(self, base_path: str, start_date_text: str, end_date_text: str) -> Dict[str, object]:
        resolved = resolve_base_path(base_path)
        if not resolved.exists():
            return {"ok": False, "message": f"Pasta nao encontrada: {resolved}"}

        try:
            start_date = parse_iso_date(start_date_text)
            end_date = parse_iso_date(end_date_text)
        except ValueError:
            return {"ok": False, "message": "Periodo invalido. Use datas no formato AAAA-MM-DD."}

        if start_date > end_date:
            return {"ok": False, "message": "Data inicial nao pode ser maior que a data final."}

        with self._lock:
            self.config_data["base_path"] = str(resolved)
            save_config(self.config_data)
            job_id = uuid4().hex
            job = ScanJob(
                job_id=job_id,
                progress_text="Preparando busca...",
                period={
                    "startDate": start_date.isoformat(),
                    "endDate": end_date.isoformat(),
                },
            )
            job.logs.append(f"[INFO] Busca iniciada em {resolved}")
            self.jobs[job_id] = job

        worker = threading.Thread(
            target=self._run_scan_job,
            args=(job_id, resolved, start_date, end_date),
            daemon=True,
        )
        worker.start()

        return {"ok": True, "jobId": job_id}

    def _run_scan_job(self, job_id: str, base_dir: Path, start_date: date, end_date: date) -> None:
        def notify(message: str) -> None:
            with self._lock:
                job = self.jobs.get(job_id)
                if job is None:
                    return
                if len(job.logs) >= 500:
                    job.logs = job.logs[-399:]
                job.logs.append(message)
                job.progress_text = message
                job.updated_at = time.time()

        try:
            notes, stats = scan_notes(base_dir, start_date, end_date, progress_callback=notify)
            serialized_notes = [serialize_note(note) for note in notes]
            note_by_id = {note_identifier(note): note for note in notes}

            with self._lock:
                self.note_by_id = note_by_id
                job = self.jobs[job_id]
                job.status = "completed"
                job.progress_text = f"Busca concluida. {len(notes)} nota(s) encontrada(s)."
                job.stats = stats
                job.notes = serialized_notes
                self.config_data["last_search_start_date"] = start_date.isoformat()
                self.config_data["last_search_end_date"] = end_date.isoformat()
                save_config(self.config_data)
                job.logs.append("-" * 80)
                job.logs.append(f"Busca concluida: {start_date.isoformat()} ate {end_date.isoformat()}")
                job.logs.append(f"CNPJs analisados: {stats['cnpjs']}")
                job.logs.append(f"Arquivos XML lidos: {stats['xml_lidos']}")
                job.logs.append(f"Notas unicas encontradas no periodo: {stats['notas_no_periodo']}")
                job.updated_at = time.time()
                job.completed_at = time.time()
        except Exception as exc:
            with self._lock:
                job = self.jobs[job_id]
                job.status = "error"
                job.error = str(exc)
                job.progress_text = "Falha na busca."
                job.logs.append(f"[ERRO] Falha ao varrer XMLs: {exc}")
                job.updated_at = time.time()
                job.completed_at = time.time()

    def get_scan_job(self, job_id: str) -> Dict[str, object]:
        with self._lock:
            job = self.jobs.get(job_id)
            if job is None:
                return {"ok": False, "message": "Busca nao encontrada."}
            return job.to_payload()

    def save_notes_zip(self, note_ids: List[str], target_path: str, start_date_text: str, end_date_text: str) -> Dict[str, object]:
        selected_notes = [self.note_by_id[note_id] for note_id in note_ids if note_id in self.note_by_id]
        if not selected_notes:
            return {"ok": False, "message": "Marque pelo menos um XML para salvar."}

        target = Path(target_path)
        try:
            start_date = parse_iso_date(start_date_text)
            end_date = parse_iso_date(end_date_text)
        except ValueError:
            start_date, end_date = default_period_range()

        added = 0
        missing = 0
        used_names: set[str] = set()

        try:
            with zipfile.ZipFile(target, mode="w", compression=zipfile.ZIP_DEFLATED) as zip_file:
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
            return {"ok": False, "message": f"Falha ao gerar arquivo ZIP: {exc}"}

        if added == 0:
            try:
                target.unlink(missing_ok=True)
            except OSError:
                pass
            return {"ok": False, "message": "Nenhum XML valido foi encontrado para compactar."}

        return {
            "ok": True,
            "targetPath": str(target),
            "added": added,
            "missing": missing,
            "defaultName": build_default_zip_name(start_date, end_date),
            "message": f"ZIP salvo com {added} XML(s).",
        }

    def copy_note_to(self, note_id: str, target_path: str) -> Dict[str, object]:
        note = self.note_by_id.get(note_id)
        if note is None:
            return {"ok": False, "message": "Nota nao encontrada na busca atual."}

        source = note.file_path
        if not source.exists():
            return {"ok": False, "message": f"Arquivo nao encontrado: {source}"}

        target = Path(target_path)
        try:
            shutil.copy2(source, target)
        except Exception as exc:
            return {"ok": False, "message": f"Nao foi possivel salvar o XML: {exc}"}

        return {
            "ok": True,
            "targetPath": str(target),
            "message": f"XML salvo em: {target}",
        }

    def open_note_location(self, note_id: str) -> Dict[str, object]:
        note = self.note_by_id.get(note_id)
        if note is None:
            return {"ok": False, "message": "Nota nao encontrada na busca atual."}

        source = note.file_path
        if not source.exists():
            return {"ok": False, "message": f"Arquivo nao encontrado: {source}"}

        try:
            if os.name == "nt":
                subprocess.run(["explorer", "/select,", str(source)], check=False)
            else:
                subprocess.run(["xdg-open", str(source.parent)], check=False)
        except Exception as exc:
            return {"ok": False, "message": f"Nao foi possivel abrir o local do arquivo: {exc}"}

        return {"ok": True, "message": "Local do arquivo aberto."}

    def get_note_xml_preview(self, note_id: str) -> Dict[str, object]:
        note = self.note_by_id.get(note_id)
        if note is None:
            return {"ok": False, "message": "Nota nao encontrada na busca atual."}

        source = note.file_path
        if not source.exists():
            return {"ok": False, "message": f"Arquivo nao encontrado: {source}"}

        try:
            xml_text = format_xml_preview(source)
        except Exception as exc:
            return {"ok": False, "message": f"Nao foi possivel carregar o XML: {exc}"}

        return {
            "ok": True,
            "message": "XML carregado para visualizacao.",
            "fileName": source.name,
            "xmlText": xml_text,
        }

    def default_zip_name(self, start_date_text: str, end_date_text: str) -> str:
        try:
            start_date = parse_iso_date(start_date_text)
            end_date = parse_iso_date(end_date_text)
        except ValueError:
            start_date, end_date = default_period_range()
        return build_default_zip_name(start_date, end_date)

    def default_xml_name(self, note_id: str) -> str:
        note = self.note_by_id.get(note_id)
        if note is None:
            return f"XML_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xml"
        return f"{note.doc_type.replace('-', '').replace(' ', '')}_{note.key}.xml"





