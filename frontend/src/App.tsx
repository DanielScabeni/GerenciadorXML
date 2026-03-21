import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Checkbox from '@radix-ui/react-checkbox'
import * as Collapsible from '@radix-ui/react-collapsible'
import * as Dialog from '@radix-ui/react-dialog'
import * as Popover from '@radix-ui/react-popover'
import type { CheckedState } from '@radix-ui/react-checkbox'
import { ptBR } from 'date-fns/locale'
import { endOfMonth, format, parseISO, startOfMonth, subMonths } from 'date-fns'
import { DayPicker, type DateRange } from 'react-day-picker'
import {
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  FileArchive,
  FileCode2,
  Filter,
  FolderOpen,
  FolderSearch,
  HardDrive,
  Logs,
  Minus,
  RefreshCcw,
  Save,
  ScanSearch,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react'

import { getDesktopBridge } from './lib/bridge'
import type {
  BackendNote,
  DesktopBridge,
  DetectionResult,
  InitialState,
  LastSearchState,
  ScanJobSnapshot,
  StartupState,
  ValidationResult,
} from './types'

type CompanyGroup = {
  id: string
  cnpj: string
  models: ModelGroup[]
}

type ModelGroup = {
  id: string
  label: string
  notes: BackendNote[]
}

type NotePreviewCache = {
  fileName: string
  xmlText: string
}

type XmlHighlightPart = {
  text: string
  matchIndex: number | null
}

type NoticeTone = 'info' | 'success' | 'error'

type NoticeState = {
  tone: NoticeTone
  message: string
}

type ContextMenuState = {
  noteId: string
  x: number
  y: number
}

const NOTE_COLUMN_KEYS = ['number', 'series', 'accessKey', 'issueDate'] as const
type NoteColumnKey = (typeof NOTE_COLUMN_KEYS)[number]

const MODEL_ORDER: Record<string, number> = {
  'NF-e': 0,
  'NFC-e': 1,
  'CT-e': 2,
}

const NOTE_COLUMN_DEFAULT_WEIGHTS: Record<NoteColumnKey, number> = {
  number: 1.1,
  series: 0.85,
  accessKey: 3.25,
  issueDate: 1.2,
}

const NOTE_COLUMN_MIN_WEIGHTS: Record<NoteColumnKey, number> = {
  number: 0.78,
  series: 0.65,
  accessKey: 1.25,
  issueDate: 1.0,
}

const NOTE_COLUMN_MAX_WEIGHTS: Record<NoteColumnKey, number> = {
  number: 2.3,
  series: 1.8,
  accessKey: 6.2,
  issueDate: 2.5,
}

const NOTE_ACTION_COLUMN_WIDTHS = {
  xml: 64,
  select: 64,
}

const NOTE_COLUMN_MIN_PIXELS: Record<NoteColumnKey, number> = {
  number: 76,
  series: 68,
  accessKey: 180,
  issueDate: 112,
}

const NOTE_GRID_GAP_PX = 12

function App() {
  const [bridge, setBridge] = useState<DesktopBridge | null>(null)
  const [isBooting, setIsBooting] = useState(true)

  const [configPath, setConfigPath] = useState('')
  const [period, setPeriod] = useState<DateRange | undefined>(createPreviousMonthRange(new Date()))
  const [lastSearchPeriod, setLastSearchPeriod] = useState<DateRange | null>(null)
  const [documentFilter, setDocumentFilter] = useState('')

  const [notes, setNotes] = useState<BackendNote[]>([])
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(new Set())
  const [noteColumnWeights, setNoteColumnWeights] = useState<Record<NoteColumnKey, number>>(NOTE_COLUMN_DEFAULT_WEIGHTS)
  const [expandedCompanies, setExpandedCompanies] = useState<Set<string>>(new Set())
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set())
  const [expandedNotePreviews, setExpandedNotePreviews] = useState<Set<string>>(new Set())
  const [loadingCompanyIds, setLoadingCompanyIds] = useState<Set<string>>(new Set())
  const [loadingModelIds, setLoadingModelIds] = useState<Set<string>>(new Set())
  const [loadingPreviewIds, setLoadingPreviewIds] = useState<Set<string>>(new Set())
  const [notePreviewById, setNotePreviewById] = useState<Record<string, NotePreviewCache>>({})

  const [configOpen, setConfigOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(true)
  const [showBootLogs, setShowBootLogs] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const [startupInfo, setStartupInfo] = useState<StartupState | null>(null)
  const [configLines, setConfigLines] = useState<string[]>([])
  const [activityLines, setActivityLines] = useState<string[]>([])
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)

  const [notice, setNotice] = useState<NoticeState>({
    tone: 'info',
    message: 'Preparando a interface. O backend continua iniciando em segundo plano.',
  })

  const [scanJobId, setScanJobId] = useState('')
  const [scanSnapshot, setScanSnapshot] = useState<ScanJobSnapshot | null>(null)
  const [busyAction, setBusyAction] = useState<null | 'config' | 'scan' | 'zip' | 'note'>(null)
  const [isStartupContextLoading, setIsStartupContextLoading] = useState(false)

  const lastLogCountRef = useRef<Record<string, number>>({})
  const bridgeRetryRef = useRef(0)
  const toggleLoadTimersRef = useRef<Record<string, number>>({})
  const previewGenerationRef = useRef(0)
  const appendLogs = useCallback((lines: string[]) => {
    if (lines.length === 0) {
      return
    }

    setActivityLines((current) => trimLogs([...current, ...lines]))
  }, [])

  const notifyBackendPending = useCallback(() => {
    setNotice({
      tone: 'info',
      message: 'O backend nativo ainda esta terminando de iniciar. Tente novamente em alguns instantes.',
    })
  }, [])

  const clearToggleTimer = useCallback((key: string) => {
    const timerId = toggleLoadTimersRef.current[key]
    if (timerId === undefined) {
      return
    }

    window.clearTimeout(timerId)
    delete toggleLoadTimersRef.current[key]
  }, [])

  const clearAllToggleTimers = useCallback(() => {
    Object.keys(toggleLoadTimersRef.current).forEach((key) => {
      const timerId = toggleLoadTimersRef.current[key]
      window.clearTimeout(timerId)
      delete toggleLoadTimersRef.current[key]
    })
  }, [])

  useEffect(() => {
    return () => {
      clearAllToggleTimers()    }
  }, [clearAllToggleTimers])

  useEffect(() => {
    let active = true
    let retryTimer = 0
    let startupTimer = 0
    let handshakeOpen = true

    appendLogs(['[INFO] Aguardando a API nativa do pywebview...'])
    setNotice({
      tone: 'info',
      message: 'Conectando ao backend nativo. A interface sera liberada assim que essa etapa terminar.',
    })

    const heartbeatTimer = window.setInterval(() => {
      if (active && handshakeOpen) {
        appendLogs(['[INFO] Aguardando o backend nativo concluir o handshake inicial...'])
      }
    }, 8000)

    const applyInitialState = (state: InitialState) => {
      document.title = state.appTitle
      setConfigPath(state.config.basePath || '')
      setPeriod({
        from: parseISO(state.defaults.startDate),
        to: parseISO(state.defaults.endDate),
      })
      setStartupInfo(state.startup)
      setValidationResult(state.validation)
      setLastSearchPeriod(parseLastSearchRange(state.lastSearch))
      setConfigLines(trimLogs([...state.startup.lines, ...(state.validation?.lines ?? [])]))

      const initialLines = [...state.startup.lines, ...(state.validation?.lines ?? [])]
      if (initialLines.length > 0) {
        appendLogs(initialLines)
      }

      setNotice({
        tone: 'info',
        message: state.startup.message,
      })
    }

    const applyStartupContext = (state: Awaited<ReturnType<DesktopBridge['loadStartupContext']>>) => {
      setStartupInfo(state.startup)
      setValidationResult(state.validation)
      setLastSearchPeriod((current) => current ?? parseLastSearchRange(state.lastSearch))
      setConfigPath((current) => current.trim() || state.config.basePath || state.startup.path || '')

      const contextLines = trimLogs([...state.startup.lines, ...(state.validation?.lines ?? [])])
      setConfigLines(contextLines)
      if (contextLines.length > 0) {
        appendLogs(contextLines)
      }

      if (state.startup.shouldPromptConfig) {
        setConfigOpen(true)
      }

      if (state.startup.mode === 'saved') {
        setNotice({
          tone: 'success',
          message: 'Configuracao carregada. Ajuste os filtros e inicie a busca quando quiser.',
        })
      } else if (state.validation && !state.validation.ok && state.config.basePath) {
        setNotice({
          tone: 'error',
          message: state.validation.message,
        })
      } else {
        setNotice({
          tone: 'info',
          message: state.startup.message,
        })
      }
    }

    const bootstrap = async () => {
      try {
        const desktopBridge = await getDesktopBridge()
        if (!active) {
          return
        }

        handshakeOpen = false
        window.clearInterval(heartbeatTimer)
        setBridge(desktopBridge)
        bridgeRetryRef.current = 0
        appendLogs(['[OK] Backend nativo conectado.'])

        const initialState = await desktopBridge.getInitialState()
        if (!active) {
          return
        }

        applyInitialState(initialState)
        setIsBooting(false)

        startupTimer = window.setTimeout(() => {
          if (!active) {
            return
          }

          setIsStartupContextLoading(true)
          void desktopBridge
            .loadStartupContext()
            .then((startupContext) => {
              if (!active) {
                return
              }
              applyStartupContext(startupContext)
            })
            .catch((error) => {
              if (!active) {
                return
              }

              const message = error instanceof Error ? error.message : 'Falha ao finalizar a configuracao inicial.'
              setNotice({
                tone: 'error',
                message,
              })
              appendLogs([`[ERRO] ${message}`])
            })
            .finally(() => {
              if (active) {
                setIsStartupContextLoading(false)
              }
            })
        }, 220)
      } catch (error) {
        if (!active) {
          return
        }

        const message = error instanceof Error ? error.message : 'Falha ao carregar a aplicacao.'
        bridgeRetryRef.current += 1
        const attempt = bridgeRetryRef.current
        const retryDelayMs = Math.min(2500 + attempt * 1250, 9000)

        setBridge(null)
        setIsBooting(true)
        setNotice({
          tone: attempt >= 3 ? 'error' : 'info',
          message:
            attempt >= 3
              ? `${message} Continuando a tentar reconectar ao backend nativo.`
              : 'Conectando ao backend nativo. A janela continua carregando ate essa etapa terminar.',
        })
        appendLogs([`[AVISO] Tentativa ${attempt} de conexao ao backend nativo falhou: ${message}`])

        retryTimer = window.setTimeout(() => {
          if (active) {
            void bootstrap()
          }
        }, retryDelayMs)
      }
    }

    void bootstrap()

    return () => {
      active = false
      window.clearInterval(heartbeatTimer)
      window.clearTimeout(retryTimer)
      window.clearTimeout(startupTimer)
    }
  }, [appendLogs])

  useEffect(() => {
    if (!bridge || !scanJobId) {
      return undefined
    }

    let active = true

    const poll = async () => {
      try {
        const result = await bridge.getScanJob(scanJobId)
        if (!active) {
          return
        }

        if (result.ok === false) {
          setBusyAction(null)
          setScanJobId('')
          setNotice({
            tone: 'error',
            message: result.message,
          })
          return
        }

        setScanSnapshot(result)
        const previousCount = lastLogCountRef.current[scanJobId] ?? 0
        if (result.logs.length > previousCount) {
          appendLogs(result.logs.slice(previousCount))
          lastLogCountRef.current[scanJobId] = result.logs.length
        }

        if (result.status === 'running') {
          setNotice({
            tone: 'info',
            message: result.progressText,
          })
          return
        }

        if (result.status === 'error') {
          setBusyAction(null)
          setScanJobId('')
          setNotice({
            tone: 'error',
            message: result.error || 'Falha ao buscar os XMLs.',
          })
          return
        }

        const nextNotes = result.notes
        setNotes(nextNotes)
        setSelectedNoteIds(new Set(nextNotes.map((note) => note.id)))
        setLastSearchPeriod(parseLastSearchRange(result.period))

        const defaults = buildExpansionDefaults()
        previewGenerationRef.current += 1
        clearAllToggleTimers()
        setExpandedCompanies(defaults.companyIds)
        setExpandedModels(defaults.modelIds)
        setExpandedNotePreviews(new Set())
        setLoadingCompanyIds(new Set())
        setLoadingModelIds(new Set())
        setLoadingPreviewIds(new Set())
        setNotePreviewById({})
        setBusyAction(null)
        setScanJobId('')
        setNotice({
          tone: 'success',
          message: `Busca concluida com ${result.stats.notas_no_periodo} nota(s) encontradas no periodo.`,
        })
      } catch (error) {
        if (!active) {
          return
        }

        setBusyAction(null)
        setScanJobId('')
        setNotice({
          tone: 'error',
          message: error instanceof Error ? error.message : 'Falha ao atualizar o progresso da busca.',
        })
      }
    }

    void poll()
    const timer = window.setInterval(() => {
      void poll()
    }, 650)

    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [appendLogs, bridge, clearAllToggleTimers, scanJobId])

  useEffect(() => {
    if (!contextMenu) {
      return undefined
    }

    const close = () => setContextMenu(null)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
      }
    }

    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [contextMenu])

  const filteredNotes = useMemo(() => {
    const term = documentFilter.trim().toLowerCase()
    if (!term) {
      return notes
    }

    const digitsOnly = term.replace(/\D/g, '')
    return notes.filter((note) => {
      const searchableCnpj = note.cnpj.replace(/\D/g, '')
      return (
        note.number.toLowerCase().includes(term) ||
        note.accessKey.toLowerCase().includes(term) ||
        note.docType.toLowerCase().includes(term) ||
        searchableCnpj.includes(digitsOnly)
      )
    })
  }, [documentFilter, notes])

  const companies = useMemo(() => groupNotes(filteredNotes), [filteredNotes])

  const visibleNoteIds = useMemo(
    () => companies.flatMap((company) => company.models.flatMap((model) => model.notes.map((note) => note.id))),
    [companies],
  )

  const stats = useMemo(() => {
    const companyCount = companies.length
    const modelCount = companies.reduce((total, company) => total + company.models.length, 0)
    const visibleSelected = visibleNoteIds.filter((noteId) => selectedNoteIds.has(noteId)).length

    return {
      companies: companyCount,
      models: modelCount,
      notes: visibleNoteIds.length,
      selectedVisible: visibleSelected,
      selectedTotal: selectedNoteIds.size,
    }
  }, [companies, selectedNoteIds, visibleNoteIds])

  const isScanRunning = scanSnapshot?.status === 'running' || busyAction === 'scan'
  const canSaveZip = selectedNoteIds.size > 0 && !isScanRunning && !!bridge
  const zipPeriod = lastSearchPeriod?.from && lastSearchPeriod?.to ? lastSearchPeriod : period

  const foundSummary = useMemo(() => {
    if (notes.length === 0) {
      return '0 XMLs'
    }

    return `${notes.length} XMLs`
  }, [notes.length])

  const selectedSummary = useMemo(() => {
    if (stats.selectedTotal === 0) {
      return '0 XMLs'
    }

    return `${stats.selectedTotal} XMLs`
  }, [stats.selectedTotal])

  const lastSearchSummary = useMemo(() => formatLastSearchRange(lastSearchPeriod), [lastSearchPeriod])

  const statusMessage =
    isScanRunning && scanSnapshot?.progressText
      ? scanSnapshot.progressText
      : isStartupContextLoading
        ? 'Carregando configuracoes complementares em segundo plano.'
        : notice.message

  const noteGridTemplate = useMemo(
    () =>
      [
        `minmax(${NOTE_COLUMN_MIN_PIXELS.number}px, ${noteColumnWeights.number}fr)`,
        `minmax(${NOTE_COLUMN_MIN_PIXELS.series}px, ${noteColumnWeights.series}fr)`,
        `minmax(${NOTE_COLUMN_MIN_PIXELS.accessKey}px, ${noteColumnWeights.accessKey}fr)`,
        `minmax(${NOTE_COLUMN_MIN_PIXELS.issueDate}px, ${noteColumnWeights.issueDate}fr)`,
        `${NOTE_ACTION_COLUMN_WIDTHS.xml}px`,
        `${NOTE_ACTION_COLUMN_WIDTHS.select}px`,
      ].join(' '),
    [noteColumnWeights],
  )

  const handleNoteColumnResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, columnKey: NoteColumnKey, nextColumnKey: NoteColumnKey) => {
      event.preventDefault()
      event.stopPropagation()

      const host = event.currentTarget.closest('[data-note-grid-host="true"]')
      if (!(host instanceof HTMLElement)) {
        return
      }

      const startClientX = event.clientX
      const startWeights = { ...noteColumnWeights }
      const computedStyle = window.getComputedStyle(host)
      const horizontalPadding = Number.parseFloat(computedStyle.paddingLeft || '0') + Number.parseFloat(computedStyle.paddingRight || '0')
      const columnGap = Number.parseFloat(computedStyle.columnGap || computedStyle.gap || '0') || NOTE_GRID_GAP_PX
      const totalFlexibleWeight = NOTE_COLUMN_KEYS.reduce((total, key) => total + startWeights[key], 0)
      const flexibleWidth = Math.max(
        host.clientWidth - horizontalPadding - NOTE_ACTION_COLUMN_WIDTHS.xml - NOTE_ACTION_COLUMN_WIDTHS.select - columnGap * (NOTE_COLUMN_KEYS.length + 1),
        320,
      )

      const restoreCursor = document.body.style.cursor
      const restoreUserSelect = document.body.style.userSelect
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onPointerMove = (moveEvent: PointerEvent) => {
        const deltaWeight = ((moveEvent.clientX - startClientX) / flexibleWidth) * totalFlexibleWeight
        setNoteColumnWeights(resizeAdjacentColumns(startWeights, columnKey, nextColumnKey, deltaWeight))
      }

      const cleanup = () => {
        document.body.style.cursor = restoreCursor
        document.body.style.userSelect = restoreUserSelect
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', cleanup)
        window.removeEventListener('pointercancel', cleanup)
      }

      event.currentTarget.setPointerCapture?.(event.pointerId)
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', cleanup)
      window.addEventListener('pointercancel', cleanup)
    },
    [noteColumnWeights],
  )

  const resetNoteColumnWeights = useCallback(() => {
    setNoteColumnWeights(NOTE_COLUMN_DEFAULT_WEIGHTS)
  }, [])
  const handleSaveConfig = async () => {
    if (!bridge || !configPath.trim()) {
      setNotice({
        tone: 'error',
        message: 'Informe uma pasta base antes de salvar a configuracao.',
      })
      return
    }

    setBusyAction('config')
    try {
      const result = await bridge.saveBasePath(configPath)
      setConfigPath(result.path)
      appendLogs([`[OK] ${result.message}`, `[INFO] Pasta base salva: ${result.path}`])
      setNotice({ tone: 'success', message: result.message })
      setConfigOpen(false)
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Falha ao salvar a configuracao.',
      })
    } finally {
      setBusyAction(null)
    }
  }

  const handleChooseBasePath = async () => {
    if (!bridge) {
      notifyBackendPending()
      return
    }

    setBusyAction('config')
    try {
      const result = await bridge.chooseBasePath(configPath)
      if (result.ok && result.path) {
        setConfigPath(result.path)
        setNotice({ tone: 'success', message: 'Pasta selecionada. Salve para manter a configuracao.' })
      }
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Falha ao selecionar a pasta base.',
      })
    } finally {
      setBusyAction(null)
    }
  }

  const handleDetectionResult = (result: DetectionResult) => {
    setConfigLines(trimLogs(result.lines))
    appendLogs(result.lines)

    if (result.ok) {
      setConfigPath(result.path)
      setNotice({ tone: 'success', message: result.message })
    } else {
      setNotice({ tone: 'error', message: result.message })
    }
  }

  const handleDetectFromDanfe = async () => {
    if (!bridge) {
      notifyBackendPending()
      return
    }

    setBusyAction('config')
    try {
      handleDetectionResult(await bridge.detectFromDanfe())
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Falha ao buscar o DANFE.ini.',
      })
    } finally {
      setBusyAction(null)
    }
  }

  const handleDetectDefaultBase = async () => {
    if (!bridge) {
      notifyBackendPending()
      return
    }

    setBusyAction('config')
    try {
      handleDetectionResult(await bridge.detectDefaultBase())
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Falha ao buscar os caminhos padrao da Unimake.',
      })
    } finally {
      setBusyAction(null)
    }
  }

  const handleTestStructure = async () => {
    if (!bridge || !configPath.trim()) {
      if (!bridge) {
        notifyBackendPending()
        return
      }

      setNotice({
        tone: 'error',
        message: 'Informe uma pasta base antes de testar a estrutura.',
      })
      return
    }

    setBusyAction('config')
    try {
      const result = await bridge.testStructure(configPath)
      setValidationResult(result)
      setConfigLines(trimLogs(result.lines))
      appendLogs(result.lines)
      setNotice({
        tone: result.ok ? 'success' : 'error',
        message: result.message,
      })
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Falha ao validar a estrutura.',
      })
    } finally {
      setBusyAction(null)
    }
  }

  const handleApplyStartupSuggestion = async () => {
    if (!bridge || !startupInfo?.path) {
      if (!bridge) {
        notifyBackendPending()
      }
      return
    }

    setBusyAction('config')
    try {
      const result = await bridge.saveBasePath(startupInfo.path)
      setConfigPath(result.path)
      appendLogs([`[OK] ${result.message}`, `[INFO] Pasta base salva: ${result.path}`])
      setNotice({ tone: 'success', message: result.message })
      setConfigOpen(false)
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Falha ao aplicar o caminho sugerido.',
      })
    } finally {
      setBusyAction(null)
    }
  }

  const handleStartScan = async () => {
    if (!bridge) {
      notifyBackendPending()
      return
    }

    const startDate = period?.from
    const endDate = period?.to
    if (!configPath.trim()) {
      setNotice({ tone: 'error', message: 'Defina a pasta base antes de buscar os XMLs.' })
      setConfigOpen(true)
      return
    }

    if (!startDate || !endDate) {
      setNotice({ tone: 'error', message: 'Selecione uma data inicial e final antes de buscar os XMLs.' })
      return
    }

    setBusyAction('scan')
    setScanSnapshot(null)
    try {
      const result = await bridge.startScan({
        basePath: configPath,
        startDate: formatIsoDate(startDate),
        endDate: formatIsoDate(endDate),
      })

      if (!result.ok || !result.jobId) {
        setBusyAction(null)
        setNotice({ tone: 'error', message: result.message || 'Nao foi possivel iniciar a busca.' })
        return
      }

      lastLogCountRef.current[result.jobId] = 0
      setScanJobId(result.jobId)
      setContextMenu(null)
      appendLogs(['-'.repeat(80), `[INFO] Busca solicitada para ${formatRange(period)}.`])
      setNotice({ tone: 'info', message: 'Busca iniciada. O progresso vai aparecer no painel de atividade.' })
    } catch (error) {
      setBusyAction(null)
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Falha ao iniciar a busca.',
      })
    }
  }

  const handleSaveZip = async () => {
    if (!bridge || !zipPeriod?.from || !zipPeriod?.to || selectedNoteIds.size === 0) {
      if (!bridge) {
        notifyBackendPending()
      }
      return
    }

    setBusyAction('zip')
    try {
      const result = await bridge.saveSelectedZip({
        noteIds: [...selectedNoteIds],
        startDate: formatIsoDate(zipPeriod.from),
        endDate: formatIsoDate(zipPeriod.to),
      })

      if (!result.ok) {
        if (!result.cancelled) {
          setNotice({ tone: 'error', message: result.message })
          appendLogs([`[ERRO] ${result.message}`])
        }
        return
      }

      setNotice({ tone: 'success', message: result.message })
      appendLogs([
        `[OK] ${result.message}`,
        ...(result.targetPath ? [`[INFO] ZIP salvo em: ${result.targetPath}`] : []),
      ])
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Falha ao salvar o ZIP.',
      })
    } finally {
      setBusyAction(null)
    }
  }

  const handleSaveNoteCopy = async (noteId: string) => {
    if (!bridge) {
      notifyBackendPending()
      return
    }

    setBusyAction('note')
    try {
      const result = await bridge.saveNoteCopy(noteId)
      if (!result.ok) {
        if (!result.cancelled) {
          setNotice({ tone: 'error', message: result.message })
        }
        return
      }

      setNotice({ tone: 'success', message: result.message })
      appendLogs([
        `[OK] ${result.message}`,
        ...(result.targetPath ? [`[INFO] XML salvo em: ${result.targetPath}`] : []),
      ])
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Falha ao salvar a copia do XML.',
      })
    } finally {
      setBusyAction(null)
      setContextMenu(null)
    }
  }

  const handleOpenNoteLocation = async (noteId: string) => {
    if (!bridge) {
      notifyBackendPending()
      return
    }

    try {
      const result = await bridge.openNoteLocation(noteId)
      if (!result.ok) {
        setNotice({ tone: 'error', message: result.message })
        return
      }

      setNotice({ tone: 'success', message: result.message })
      appendLogs([`[OK] ${result.message}`])
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Falha ao abrir o local do arquivo.',
      })
    } finally {
      setContextMenu(null)
    }
  }

  const handleCompanyToggle = useCallback((companyId: string) => {
    const timerKey = `company:${companyId}`

    if (expandedCompanies.has(companyId)) {
      clearToggleTimer(timerKey)
      setLoadingCompanyIds((current) => removeSetValue(current, companyId))
      setExpandedCompanies((current) => removeSetValue(current, companyId))
      return
    }

    if (loadingCompanyIds.has(companyId)) {
      return
    }

    setLoadingCompanyIds((current) => addSetValue(current, companyId))
    clearToggleTimer(timerKey)
    toggleLoadTimersRef.current[timerKey] = window.setTimeout(() => {
      delete toggleLoadTimersRef.current[timerKey]
      setLoadingCompanyIds((current) => removeSetValue(current, companyId))
      setExpandedCompanies((current) => addSetValue(current, companyId))
    }, 180)
  }, [clearToggleTimer, expandedCompanies, loadingCompanyIds])

  const handleModelToggle = useCallback((modelId: string) => {
    const timerKey = `model:${modelId}`

    if (expandedModels.has(modelId)) {
      clearToggleTimer(timerKey)
      setLoadingModelIds((current) => removeSetValue(current, modelId))
      setExpandedModels((current) => removeSetValue(current, modelId))
      return
    }

    if (loadingModelIds.has(modelId)) {
      return
    }

    setLoadingModelIds((current) => addSetValue(current, modelId))
    clearToggleTimer(timerKey)
    toggleLoadTimersRef.current[timerKey] = window.setTimeout(() => {
      delete toggleLoadTimersRef.current[timerKey]
      setLoadingModelIds((current) => removeSetValue(current, modelId))
      setExpandedModels((current) => addSetValue(current, modelId))
    }, 180)
  }, [clearToggleTimer, expandedModels, loadingModelIds])

  const handleNotePreviewToggle = useCallback(async (noteId: string) => {
    if (expandedNotePreviews.has(noteId)) {
      setExpandedNotePreviews((current) => removeSetValue(current, noteId))
      return
    }

    if (loadingPreviewIds.has(noteId)) {
      return
    }

    const cachedPreview = notePreviewById[noteId]
    if (cachedPreview) {
      setExpandedNotePreviews((current) => addSetValue(current, noteId))
      return
    }

    if (!bridge) {
      notifyBackendPending()
      return
    }

    const requestGeneration = previewGenerationRef.current
    setLoadingPreviewIds((current) => addSetValue(current, noteId))

    try {
      const result = await bridge.getNoteXmlPreview(noteId)
      if (previewGenerationRef.current !== requestGeneration) {
        return
      }

      if (!result.ok || !result.xmlText) {
        setNotice({ tone: 'error', message: result.message })
        appendLogs([`[ERRO] ${result.message}`])
        return
      }

      const xmlText = result.xmlText
      setNotePreviewById((current) => ({
        ...current,
        [noteId]: {
          fileName: result.fileName || 'XML',
          xmlText,
        },
      }))
      setExpandedNotePreviews((current) => addSetValue(current, noteId))
    } catch (error) {
      if (previewGenerationRef.current !== requestGeneration) {
        return
      }

      const message = error instanceof Error ? error.message : 'Falha ao carregar o XML para visualizacao.'
      setNotice({ tone: 'error', message })
      appendLogs([`[ERRO] ${message}`])
    } finally {
      setLoadingPreviewIds((current) => removeSetValue(current, noteId))
    }
  }, [appendLogs, bridge, expandedNotePreviews, loadingPreviewIds, notePreviewById, notifyBackendPending])

  const handleToggleAllVisible = (checked: boolean) => {
    setSelectedNoteIds((current) => {
      const next = new Set(current)
      visibleNoteIds.forEach((noteId) => {
        if (checked) {
          next.add(noteId)
        } else {
          next.delete(noteId)
        }
      })
      return next
    })
  }

  const handleToggleMany = (noteIds: string[], checked: boolean) => {
    setSelectedNoteIds((current) => {
      const next = new Set(current)
      noteIds.forEach((noteId) => {
        if (checked) {
          next.add(noteId)
        } else {
          next.delete(noteId)
        }
      })
      return next
    })
  }

  const handleToggleOne = (noteId: string, checked: boolean) => {
    setSelectedNoteIds((current) => {
      const next = new Set(current)
      if (checked) {
        next.add(noteId)
      } else {
        next.delete(noteId)
      }
      return next
    })
  }

  const handleResetFilters = () => {
    setDocumentFilter('')
    setPeriod(createPreviousMonthRange(new Date()))
    setNotice({ tone: 'info', message: 'Filtros resetados para o periodo padrao.' })
  }

  const handleUseCurrentMonth = () => {
    setPeriod(createCurrentMonthRange(new Date()))
  }

  const handleUsePreviousMonth = () => {
    setPeriod(createPreviousMonthRange(new Date()))
  }

  if (isBooting) {
    return <LoadingScreen message={notice.message} logs={activityLines} logOpen={showBootLogs} onToggleLogs={() => setShowBootLogs((current) => !current)} />
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(30,64,175,0.24),_transparent_26%),linear-gradient(180deg,#020617_0%,#020817_48%,#030712_100%)] text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-[1680px] flex-col lg:flex-row">
        <aside className="flex w-full flex-col border-b border-white/10 bg-slate-950/72 backdrop-blur lg:min-h-screen lg:w-[336px] lg:border-b-0 lg:border-r xl:w-[356px]">
          <div className="border-b border-white/10 px-5 py-5 sm:px-6">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-cyan-300/30 bg-cyan-400/10 shadow-[0_0_32px_rgba(34,211,238,0.14)]">
                  <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="" className="size-full object-contain p-1.5" />
                </div>
                <div className="min-w-0">
                  <h1 className="truncate text-xl font-semibold text-white">Gerenciador de XML</h1>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setConfigOpen(true)}
                title="Abrir configuracao"
                className="inline-flex size-12 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-slate-200 shadow-[0_12px_32px_rgba(2,6,23,0.34)] transition hover:border-cyan-300/40 hover:bg-cyan-400/10 hover:text-cyan-100"
                aria-label="Abrir configuracao"
              >
                <Settings2 className="size-5" />
              </button>
            </div>
          </div>

          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
            <SidebarCard icon={<CalendarDays className="size-4" />} title="Periodo">
              <RangePicker value={period} onChange={setPeriod} />
              <div className="grid grid-cols-2 gap-2">
                <QuickAction onClick={handleUseCurrentMonth}>Mes atual</QuickAction>
                <QuickAction onClick={handleUsePreviousMonth}>Mes anterior</QuickAction>
              </div>
              <ActionButton variant="green" onClick={handleStartScan} disabled={!bridge || isScanRunning} icon={<ScanSearch className="size-4" />} className="w-full">
                {isScanRunning ? 'Buscando XMLs...' : 'Buscar XMLs'}
              </ActionButton>
            </SidebarCard>

            <SidebarCard icon={<Filter className="size-4" />} title="Filtro rapido">
              <label className="block space-y-2">
                <span className="text-sm font-medium text-slate-200">Numero, chave ou CNPJ</span>
                <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-900/80 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                  <Search className="size-4 text-slate-500" />
                  <input
                    value={documentFilter}
                    onChange={(event) => setDocumentFilter(event.target.value)}
                    placeholder="14582, 352603... ou CNPJ"
                    className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-500"
                  />
                </div>
              </label>

              <button
                type="button"
                onClick={handleResetFilters}
                title="Limpa o filtro textual e volta para o periodo padrao do mes anterior."
                className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium uppercase tracking-[0.18em] text-slate-200 transition hover:border-white/20 hover:bg-white/[0.08]"
              >
                <RefreshCcw className="size-3.5" />
                Resetar filtros
              </button>
            </SidebarCard>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <StatCard label="CNPJs" value={String(stats.companies).padStart(2, '0')} />
              <StatCard label="Modelos" value={String(stats.models).padStart(2, '0')} />
              <StatCard label="Notas" value={String(stats.notes).padStart(2, '0')} />
              <StatCard label="Marcadas" value={String(stats.selectedTotal).padStart(2, '0')} />
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-7 lg:py-7 xl:px-8">
          <div className="flex flex-col gap-5 pb-28">
            <section className="rounded-[32px] border border-white/10 bg-slate-950/56 p-5 shadow-[0_28px_90px_rgba(2,6,23,0.5)] backdrop-blur sm:p-6">
              <div className="flex flex-col gap-3">
                <div className="rounded-[28px] border border-white/10 bg-white/[0.03] px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                    <div className="min-w-0">
                      <p className="text-xs uppercase tracking-[0.28em] text-cyan-200/70">Pasta base</p>
                      <p title={configPath || 'Nao configurada ainda'} className="mt-2 truncate text-sm font-medium text-white sm:text-base">
                        {configPath || 'Nao configurada ainda'}
                      </p>
                    </div>
                    <ActionButton
                      variant="secondary"
                      onClick={() => setConfigOpen(true)}
                      icon={<HardDrive className="size-4" />}
                      className="w-full justify-center sm:w-auto sm:shrink-0"
                    >
                      Configuracao
                    </ActionButton>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <InfoPill label="Periodo selecionado" value={lastSearchSummary} />
                  <InfoPill label="XMLs encontrados" value={foundSummary} />
                  <InfoPill label="Total selecionado" value={selectedSummary} />
                </div>
              </div>
              <div className="mt-4">
                <NoticeCard tone={notice.tone} message={statusMessage} />
              </div>
            </section>

            <section className="rounded-[32px] border border-white/10 bg-slate-950/56 p-4 shadow-[0_28px_90px_rgba(2,6,23,0.42)] backdrop-blur sm:p-5 lg:p-6">
              <div className="flex flex-col gap-4 border-b border-white/8 pb-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-white">Arvore de XMLs</h3>
                  <p className="mt-1 text-sm text-slate-400">Agrupamento por CNPJ e modelo. Nas notas, selecione, salve ou abra o local do arquivo.</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium uppercase tracking-[0.18em] text-slate-300">
                    {stats.notes} nota(s) visiveis
                  </div>
                  <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2">
                    <span className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">Tudo visivel</span>
                    <CheckboxShell
                      checked={deriveCheckedState(visibleNoteIds, selectedNoteIds)}
                      label="Selecionar todos os XMLs visiveis"
                      onCheckedChange={(checked) => handleToggleAllVisible(checked === true)}
                    />
                  </div>
                </div>
              </div>

              {companies.length === 0 ? (
                <EmptyState
                  title={notes.length === 0 ? 'Nenhum XML carregado ainda' : 'Nenhum XML ficou visivel com esse filtro'}
                  description={
                    notes.length === 0
                      ? 'Use o botao Buscar XMLs na secao de periodo para carregar os XMLs do periodo configurado.'
                      : 'O filtro textual removeu todos os itens visiveis. Resetar filtros volta para o periodo padrao sem perder a configuracao salva.'
                  }
                  actionLabel={notes.length === 0 ? 'Abrir configuracao' : 'Resetar filtros'}
                  onAction={() => {
                    if (notes.length === 0) {
                      setConfigOpen(true)
                    } else {
                      handleResetFilters()
                    }
                  }}
                />
              ) : (
                <div className="space-y-4 pt-4">
                  {companies.map((company) => {
                    const companyNoteIds = company.models.flatMap((model) => model.notes.map((note) => note.id))
                    const companyState = deriveCheckedState(companyNoteIds, selectedNoteIds)
                    const companyOpen = expandedCompanies.has(company.id)
                    const companyLoading = loadingCompanyIds.has(company.id)

                    return (
                      <Collapsible.Root key={company.id} open={companyOpen} onOpenChange={() => handleCompanyToggle(company.id)}>
                        <div className="rounded-[28px] border border-white/10 bg-white/[0.03] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                          <div className="flex items-center gap-3 px-4 py-4 sm:px-5">
                            <Collapsible.Trigger asChild>
                              <button
                                type="button"
                                aria-busy={companyLoading}
                                className="flex min-w-0 flex-1 items-center gap-4 rounded-2xl text-left outline-none transition hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-cyan-300/70"
                              >
                                <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-cyan-300/20 bg-cyan-400/10 text-cyan-100">
                                  {companyLoading ? <InlineLoader compact /> : companyOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="flex flex-wrap items-center gap-3">
                                    <span className="inline-flex items-center gap-2 text-base font-semibold text-white">
                                      <Building2 className="size-4 text-cyan-200" />
                                      {company.cnpj}
                                    </span>
                                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-slate-300">
                                      {companyNoteIds.length} XMLs
                                    </span>
                                  </span>
                                  <span className="mt-1 block text-sm text-slate-400">
                                    {companyLoading ? 'Preparando modelos e notas deste CNPJ...' : 'Selecione o CNPJ inteiro ou refine pelo modelo abaixo.'}
                                  </span>
                                </span>
                              </button>
                            </Collapsible.Trigger>

                            <CheckboxShell checked={companyState} label={`Selecionar todos os XMLs do CNPJ ${company.cnpj}`} onCheckedChange={(checked) => handleToggleMany(companyNoteIds, checked === true)} />
                          </div>

                          <Collapsible.Content className="collapsible-panel overflow-hidden border-t border-white/8 px-3 pb-3 sm:px-4">
                            <div className="space-y-3 pt-3">
                              {company.models.map((model) => {
                                const modelNoteIds = model.notes.map((note) => note.id)
                                const modelState = deriveCheckedState(modelNoteIds, selectedNoteIds)
                                const modelOpen = expandedModels.has(model.id)
                                const modelLoading = loadingModelIds.has(model.id)

                                return (
                                  <Collapsible.Root key={model.id} open={modelOpen} onOpenChange={() => handleModelToggle(model.id)}>
                                    <div className="rounded-[24px] border border-white/8 bg-slate-950/52">
                                      <div className="flex items-center gap-3 px-4 py-3.5">
                                        <Collapsible.Trigger asChild>
                                          <button
                                            type="button"
                                            aria-busy={modelLoading}
                                            className="flex min-w-0 flex-1 items-center gap-4 rounded-2xl text-left outline-none transition hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-cyan-300/70"
                                          >
                                            <span className="flex size-9 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-slate-200">
                                              {modelLoading ? <InlineLoader compact /> : modelOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                                            </span>
                                            <span className="min-w-0 flex-1">
                                              <span className="inline-flex items-center gap-2 text-sm font-semibold text-white">
                                                <FileCode2 className="size-4 text-cyan-200" />
                                                {model.label}
                                              </span>
                                              <span className="mt-1 block text-sm text-slate-400">
                                                {modelLoading ? 'Preparando notas deste modelo...' : `${model.notes.length} nota(s) visiveis neste modelo`}
                                              </span>
                                            </span>
                                          </button>
                                        </Collapsible.Trigger>

                                        <CheckboxShell checked={modelState} label={`Selecionar todos os XMLs do modelo ${model.label}`} onCheckedChange={(checked) => handleToggleMany(modelNoteIds, checked === true)} />
                                      </div>

                                      <Collapsible.Content className="collapsible-panel overflow-hidden border-t border-white/8 px-3 pb-3 sm:px-4">
                                        <div className="overflow-hidden rounded-[22px] border border-white/8 bg-slate-950/72">
                                          <div className="flex flex-col gap-3 border-b border-white/8 bg-white/[0.04] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                                            <p className="text-xs uppercase tracking-[0.18em] text-slate-400">
                                              Duplo clique salva uma copia. O botao XML abre a visualizacao identada e o botao direito abre as acoes do arquivo.
                                            </p>
                                            <button
                                              type="button"
                                              onClick={resetNoteColumnWeights}
                                              className="inline-flex items-center justify-center self-start rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-300 transition hover:border-cyan-300/35 hover:bg-cyan-400/10 hover:text-cyan-100"
                                              title="Volta as larguras padrao das colunas de dados."
                                            >
                                              Resetar colunas
                                            </button>
                                          </div>
                                          <div className="overflow-hidden">
                                            <div
                                              data-note-grid-host="true"
                                              className="grid items-center gap-3 border-b border-white/8 bg-white/[0.04] px-4 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400"
                                              style={{ gridTemplateColumns: noteGridTemplate }}
                                            >
                                              <NoteColumnHeader
                                                label="Numero"
                                                columnKey="number"
                                                onResizeStart={handleNoteColumnResizeStart}
                                              />
                                              <NoteColumnHeader
                                                label="Serie"
                                                columnKey="series"
                                                onResizeStart={handleNoteColumnResizeStart}
                                              />
                                              <NoteColumnHeader
                                                label="Chave"
                                                columnKey="accessKey"
                                                onResizeStart={handleNoteColumnResizeStart}
                                              />
                                              <NoteColumnHeader
                                                label="Emissao"
                                                columnKey="issueDate"
                                                onResizeStart={handleNoteColumnResizeStart}
                                              />
                                              <span className="truncate text-center">XML</span>
                                              <span className="truncate text-right">Sel.</span>
                                            </div>

                                            <div className="divide-y divide-white/6">
                                              {model.notes.map((note) => {
                                                const previewOpen = expandedNotePreviews.has(note.id)
                                                const previewLoading = loadingPreviewIds.has(note.id)
                                                const previewCache = notePreviewById[note.id]

                                                return (
                                                  <div key={note.id}>
                                                    <div
                                                      onDoubleClick={() => void handleSaveNoteCopy(note.id)}
                                                      onContextMenu={(event) => {
                                                        event.preventDefault()
                                                        setContextMenu({ noteId: note.id, x: event.clientX, y: event.clientY })
                                                      }}
                                                      className="grid cursor-default items-center gap-3 px-4 py-3 text-sm text-slate-200 transition hover:bg-cyan-400/[0.06]"
                                                      style={{ gridTemplateColumns: noteGridTemplate }}
                                                    >
                                                      <span className="min-w-0 truncate font-medium text-white" title={note.number}>
                                                        {note.number}
                                                      </span>
                                                      <span className="min-w-0 truncate text-slate-300" title={note.series}>
                                                        {note.series}
                                                      </span>
                                                      <span className="min-w-0 truncate font-mono text-[13px] text-slate-400" title={note.accessKey}>
                                                        {note.accessKey}
                                                      </span>
                                                      <span className="min-w-0 truncate text-slate-300" title={formatIssuedDate(note.issueDate)}>
                                                        {formatIssuedDate(note.issueDate)}
                                                      </span>
                                                      <div className="flex justify-center">
                                                        <button
                                                          type="button"
                                                          aria-busy={previewLoading}
                                                          title={previewOpen ? 'Ocultar XML' : 'Visualizar XML'}
                                                          onClick={(event) => {
                                                            event.stopPropagation()
                                                            void handleNotePreviewToggle(note.id)
                                                          }}
                                                          onDoubleClick={(event) => event.stopPropagation()}
                                                          className="inline-flex size-10 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-slate-200 transition hover:border-cyan-300/35 hover:bg-cyan-400/10 hover:text-cyan-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
                                                        >
                                                          {previewLoading ? <InlineLoader compact /> : previewOpen ? <ChevronDown className="size-4" /> : <FileCode2 className="size-4" />}
                                                        </button>
                                                      </div>
                                                      <div className="flex justify-end">
                                                        <CheckboxShell
                                                          checked={selectedNoteIds.has(note.id)}
                                                          label={`Selecionar nota ${note.number}`}
                                                          onCheckedChange={(checked) => handleToggleOne(note.id, checked === true)}
                                                        />
                                                      </div>
                                                    </div>

                                                    {(previewLoading || previewOpen) && (
                                                      <div className="border-t border-white/8 bg-slate-950/88 px-4 py-4">
                                                        {previewLoading ? (
                                                          <div className="rounded-[22px] border border-cyan-300/15 bg-cyan-400/[0.06] px-4 py-4 text-sm text-slate-200">
                                                            <InlineLoader label="Carregando XML para visualizacao..." />
                                                          </div>
                                                        ) : previewCache ? (
                                                          <XmlPreviewPanel fileName={previewCache.fileName} xmlText={previewCache.xmlText} />
                                                        ) : null}
                                                      </div>
                                                    )}
                                                  </div>
                                                )
                                              })}
                                            </div>
                                          </div>
                                        </div>
                                      </Collapsible.Content>
                                    </div>
                                  </Collapsible.Root>
                                )
                              })}
                            </div>
                          </Collapsible.Content>
                        </div>
                      </Collapsible.Root>
                    )
                  })}
                </div>
              )}
            </section>

            <Collapsible.Root open={activityOpen} onOpenChange={setActivityOpen}>
              <section className="rounded-[32px] border border-white/10 bg-slate-950/56 shadow-[0_28px_90px_rgba(2,6,23,0.32)] backdrop-blur">
                <div className="flex flex-col gap-3 border-b border-white/8 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                  <div className="flex items-center gap-3">
                    <div className="flex size-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-slate-200">
                      <Logs className="size-5" />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-white">Atividade</h3>
                      <p className="text-sm text-slate-400">Visibilidade do processo, validacoes e mensagens de exportacao.</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium uppercase tracking-[0.18em] text-slate-300">
                      {activityLines.length} linha(s)
                    </div>
                    <Collapsible.Trigger asChild>
                      <button
                        type="button"
                        className="inline-flex size-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-slate-200 transition hover:border-cyan-300/40 hover:bg-cyan-400/10 hover:text-cyan-50"
                        aria-label="Alternar painel de atividade"
                      >
                        {activityOpen ? <ChevronDown className="size-5" /> : <ChevronRight className="size-5" />}
                      </button>
                    </Collapsible.Trigger>
                  </div>
                </div>

                <Collapsible.Content className="collapsible-panel">
                  <div className="max-h-[220px] overflow-auto px-5 py-4 font-mono text-[13px] leading-6 text-slate-300 sm:px-6">
                    {activityLines.length === 0 ? (
                      <p className="text-slate-500">Nenhuma atividade registrada ainda.</p>
                    ) : (
                      activityLines.map((line, index) => (
                        <div key={`${index}-${line}`} className="border-b border-white/5 py-1 last:border-b-0">
                          {line}
                        </div>
                      ))
                    )}
                  </div>
                </Collapsible.Content>
              </section>
            </Collapsible.Root>
          </div>
        </main>
      </div>

      <FloatingZipButton
        count={selectedNoteIds.size}
        disabled={!canSaveZip}
        isSaving={busyAction === 'zip'}
        onClick={() => void handleSaveZip()}
      />
      <ConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        configPath={configPath}
        onConfigPathChange={setConfigPath}
        startupInfo={startupInfo}
        lines={configLines}
        validationResult={validationResult}
        isBusy={busyAction === 'config'}
        bridgeReady={!!bridge}
        onApplySuggestion={() => void handleApplyStartupSuggestion()}
        onChoosePath={() => void handleChooseBasePath()}
        onDetectFromDanfe={() => void handleDetectFromDanfe()}
        onDetectDefault={() => void handleDetectDefaultBase()}
        onTestStructure={() => void handleTestStructure()}
        onSave={() => void handleSaveConfig()}
      />

      {contextMenu && (
        <div
          className="fixed z-50 min-w-[220px] rounded-2xl border border-white/10 bg-slate-950/96 p-2 shadow-[0_24px_80px_rgba(2,6,23,0.7)]"
          style={{ left: clamp(contextMenu.x, 16, window.innerWidth - 236), top: clamp(contextMenu.y, 16, window.innerHeight - 132) }}
          onClick={(event) => event.stopPropagation()}
        >
          <ContextMenuButton onClick={() => void handleSaveNoteCopy(contextMenu.noteId)}>
            Salvar copia do XML
          </ContextMenuButton>
          <ContextMenuButton onClick={() => void handleOpenNoteLocation(contextMenu.noteId)}>
            Abrir local do arquivo
          </ContextMenuButton>
        </div>
      )}
    </div>
  )
}

type LoadingScreenProps = {
  message?: string
  logs?: string[]
  logOpen: boolean
  onToggleLogs: () => void
}

type SidebarCardProps = {
  icon: ReactNode
  title: string
  children: ReactNode
}

function InlineLoader({ label, compact = false }: { label?: string; compact?: boolean }) {
  const spinnerSize = compact ? 'size-4 border-[1.5px]' : 'size-5 border-2'
  const labelClass = compact ? 'text-xs' : 'text-sm'

  return (
    <span className={`inline-flex items-center gap-2 ${labelClass} text-cyan-100`}>
      <span className={`${spinnerSize} rounded-full border-cyan-200/25 border-t-cyan-100 animate-spin`} />
      {label ? <span className="leading-none">{label}</span> : null}
    </span>
  )
}

function NoteColumnHeader({
  label,
  columnKey,
  onResizeStart,
}: {
  label: string
  columnKey: NoteColumnKey
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>, columnKey: NoteColumnKey, nextColumnKey: NoteColumnKey) => void
}) {
  const columnIndex = NOTE_COLUMN_KEYS.indexOf(columnKey)
  const nextColumnKey = NOTE_COLUMN_KEYS[columnIndex + 1]

  return (
    <div className="relative min-w-0 pr-3">
      <span className="block truncate">{label}</span>
      {nextColumnKey ? (
        <button
          type="button"
          aria-label={`Redimensionar coluna ${label}`}
          title={`Arraste para ajustar a largura da coluna ${label}. Duplo clique no botao Resetar colunas volta ao padrao.`}
          onPointerDown={(event) => onResizeStart(event, columnKey, nextColumnKey)}
          onDoubleClick={(event) => event.stopPropagation()}
          className="group absolute -right-2 top-1/2 flex h-9 w-4 -translate-y-1/2 cursor-col-resize touch-none items-center justify-center"
        >
          <span className="h-6 w-px rounded-full bg-white/12 transition group-hover:h-7 group-hover:bg-cyan-300/55 group-focus-visible:bg-cyan-300/55" />
        </button>
      ) : null}
    </div>
  )
}

function XmlPreviewPanel({ fileName, xmlText }: NotePreviewCache) {
  const [searchTerm, setSearchTerm] = useState('')
  const trimmedSearchTerm = searchTerm.trim()
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)
  const matchRefs = useRef<Array<HTMLElement | null>>([])
  const xmlSearchMatches = useMemo(() => findXmlSearchMatches(xmlText, trimmedSearchTerm), [trimmedSearchTerm, xmlText])
  const matchCount = xmlSearchMatches.length
  const currentMatchIndex = matchCount === 0 ? 0 : Math.min(activeMatchIndex, matchCount - 1)
  const highlightedXml = useMemo(() => buildHighlightedXml(xmlText, xmlSearchMatches), [xmlSearchMatches, xmlText])

  useEffect(() => {
    matchRefs.current = []
  }, [trimmedSearchTerm, xmlText])

  useEffect(() => {
    if (matchCount === 0) {
      return
    }

    const target = matchRefs.current[currentMatchIndex]
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [currentMatchIndex, matchCount])

  const handleStepMatch = (direction: 1 | -1) => {
    if (matchCount === 0) {
      return
    }

    setActiveMatchIndex((current) => {
      const next = current + direction
      if (next < 0) {
        return matchCount - 1
      }
      if (next >= matchCount) {
        return 0
      }
      return next
    })
  }

  return (
    <div className="overflow-hidden rounded-[24px] border border-white/10 bg-slate-950/92 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className="border-b border-white/8 bg-white/[0.04] px-4 py-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-cyan-200/70">Visualizacao do XML</p>
            <p className="mt-1 text-sm font-medium text-white">Somente leitura, com identacao para conferencia.</p>
          </div>
          <p className="truncate font-mono text-[12px] text-slate-400" title={fileName}>
            {fileName}
          </p>
        </div>
        <div className="mt-3 flex flex-col gap-3 xl:flex-row xl:items-center">
          <label className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/85 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            <Search className="size-4 shrink-0 text-slate-500" />
            <input
              value={searchTerm}
              onChange={(event) => {
                setSearchTerm(event.target.value)
                setActiveMatchIndex(0)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  handleStepMatch(event.shiftKey ? -1 : 1)
                }
              }}
              placeholder="Pesquisar por tag, atributo ou valor dentro do XML"
              className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-500"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium uppercase tracking-[0.16em] text-slate-300">
              {trimmedSearchTerm ? `${matchCount} ocorrencia(s)` : 'Busca no XML'}
            </div>
            <button
              type="button"
              onClick={() => handleStepMatch(-1)}
              disabled={matchCount === 0}
              className="inline-flex items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-300 transition hover:border-cyan-300/35 hover:bg-cyan-400/10 hover:text-cyan-100 disabled:cursor-not-allowed disabled:border-white/8 disabled:text-slate-500"
            >
              Anterior
            </button>
            <button
              type="button"
              onClick={() => handleStepMatch(1)}
              disabled={matchCount === 0}
              className="inline-flex items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-300 transition hover:border-cyan-300/35 hover:bg-cyan-400/10 hover:text-cyan-100 disabled:cursor-not-allowed disabled:border-white/8 disabled:text-slate-500"
            >
              Proxima
            </button>
            {trimmedSearchTerm ? (
              <button
                type="button"
                onClick={() => {
                  setSearchTerm('')
                  setActiveMatchIndex(0)
                }}
                className="inline-flex items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-300 transition hover:border-cyan-300/35 hover:bg-cyan-400/10 hover:text-cyan-100"
              >
                Limpar
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <div className="max-h-[420px] overflow-auto px-4 py-4">
        <pre className="whitespace-pre-wrap break-all font-mono text-[12px] leading-6 text-slate-200">
          {highlightedXml.map((part, index) =>
            part.matchIndex === null ? (
              <span key={`xml-text-${index}`}>{part.text}</span>
            ) : (
              <mark
                key={`xml-match-${part.matchIndex}`}
                ref={(element) => {
                  if (part.matchIndex !== null) {
                    matchRefs.current[part.matchIndex] = element
                  }
                }}
                className={part.matchIndex === currentMatchIndex ? 'rounded bg-amber-300 px-0.5 text-slate-950' : 'rounded bg-cyan-300/35 px-0.5 text-cyan-50'}
              >
                {part.text}
              </mark>
            ),
          )}
        </pre>
      </div>
    </div>
  )
}

function LoadingScreen({ message = 'Preparando a aplicacao...', logs = [], logOpen, onToggleLogs }: LoadingScreenProps) {
  const visibleLogs = logs.slice(-18)

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(30,64,175,0.22),_transparent_28%),linear-gradient(180deg,#020617_0%,#020817_100%)] px-6 text-slate-100">
      <button
        type="button"
        onClick={onToggleLogs}
        title={logOpen ? 'Ocultar logs de inicializacao' : 'Abrir logs de inicializacao'}
        className="absolute right-5 top-5 z-20 inline-flex size-11 items-center justify-center rounded-2xl border border-white/10 bg-slate-950/76 text-slate-200 shadow-[0_16px_40px_rgba(2,6,23,0.4)] backdrop-blur transition hover:border-cyan-300/40 hover:bg-cyan-400/10 hover:text-cyan-50"
        aria-label="Alternar logs de inicializacao"
      >
        <Logs className="size-4" />
      </button>

      {logOpen ? (
        <div className="pointer-events-none fixed inset-x-4 bottom-5 z-20 flex justify-end">
          <div className="pointer-events-auto w-full max-w-[560px] overflow-hidden rounded-[28px] border border-white/10 bg-slate-950/94 shadow-[0_28px_90px_rgba(2,6,23,0.6)] backdrop-blur">
            <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-cyan-200/70">Inicializacao</p>
                <p className="mt-1 text-sm font-medium text-white">Logs de conexao com o backend</p>
              </div>
              <button
                type="button"
                onClick={onToggleLogs}
                className="inline-flex size-9 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-slate-200 transition hover:border-cyan-300/40 hover:bg-cyan-400/10 hover:text-cyan-50"
                aria-label="Fechar logs de inicializacao"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="max-h-[280px] overflow-auto px-4 py-3 font-mono text-[12px] leading-6 text-slate-300">
              {visibleLogs.length === 0 ? <p className="text-slate-500">Nenhuma linha registrada ainda.</p> : visibleLogs.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
            </div>
          </div>
        </div>
      ) : null}

      <div className="w-full max-w-[440px] rounded-[36px] border border-white/10 bg-slate-950/72 px-8 py-9 text-center shadow-[0_28px_90px_rgba(2,6,23,0.55)] backdrop-blur">
        <div className="mx-auto flex size-16 items-center justify-center overflow-hidden rounded-[22px] border border-cyan-300/30 bg-cyan-400/10 shadow-[0_0_40px_rgba(34,211,238,0.14)]">
          <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="" className="size-full object-contain p-2" />
        </div>
        <div className="mt-8 flex justify-center">
          <div className="intro-loader" aria-hidden="true">
            <div className="intro-loader__circle">
              <div className="intro-loader__dot" />
              <div className="intro-loader__outline" />
            </div>
            <div className="intro-loader__circle">
              <div className="intro-loader__dot" />
              <div className="intro-loader__outline" />
            </div>
            <div className="intro-loader__circle">
              <div className="intro-loader__dot" />
              <div className="intro-loader__outline" />
            </div>
            <div className="intro-loader__circle">
              <div className="intro-loader__dot" />
              <div className="intro-loader__outline" />
            </div>
          </div>
        </div>
        <p className="mt-8 text-sm font-medium uppercase tracking-[0.22em] text-cyan-200/70">Inicializando</p>
        <p className="mt-3 text-base leading-7 text-slate-300">{message}</p>
        <p className="mt-3 text-sm leading-6 text-slate-500">A janela libera assim que o backend nativo terminar o handshake inicial.</p>
      </div>
    </div>
  )
}

function SidebarCard({ icon, title, children }: SidebarCardProps) {
  return (
    <section className="rounded-[28px] border border-white/10 bg-white/[0.03] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium uppercase tracking-[0.18em] text-slate-300">
        {icon}
        {title}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

type ActionButtonVariant = 'secondary' | 'green' | 'orange' | 'red'

type ActionButtonProps = {
  children: ReactNode
  icon?: ReactNode
  variant: ActionButtonVariant
  onClick?: () => void
  disabled?: boolean
  className?: string
}
function ActionButton({ children, icon, variant, onClick, disabled = false, className = '' }: ActionButtonProps) {
  const baseClasses =
    'inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 disabled:cursor-not-allowed disabled:opacity-55'
  const variantClasses =
    variant === 'green'
      ? 'border border-emerald-300/18 bg-emerald-500/14 text-emerald-50 hover:border-emerald-200/38 hover:bg-emerald-400/18'
      : variant === 'orange'
        ? 'border border-orange-300/20 bg-orange-950/45 text-orange-50 hover:border-orange-200/40 hover:bg-orange-900/55'
        : variant === 'red'
          ? 'border border-rose-300/18 bg-rose-950/42 text-rose-50 hover:border-rose-200/38 hover:bg-rose-900/50'
          : 'border border-white/10 bg-white/[0.04] text-slate-200 hover:border-white/20 hover:bg-white/[0.08]'

  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${baseClasses} ${variantClasses} ${className}`}>
      {icon}
      {children}
    </button>
  )
}

function QuickAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-300 transition hover:border-cyan-300/35 hover:bg-cyan-400/10 hover:text-cyan-100"
    >
      {children}
    </button>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[24px] border border-white/10 bg-white/[0.03] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-white">{value}</p>
    </div>
  )
}

function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[28px] border border-white/10 bg-white/[0.04] px-5 py-4 text-slate-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className="flex h-full min-h-[92px] flex-col justify-between gap-3">
        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{label}</p>
        <p className="text-base font-semibold leading-7 text-white sm:text-lg">{value}</p>
      </div>
    </div>
  )
}

function NoticeCard({ tone, message }: NoticeState) {
  const classes =
    tone === 'success'
      ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-50'
      : tone === 'error'
        ? 'border-rose-400/18 bg-rose-400/10 text-rose-50'
        : 'border-cyan-300/15 bg-cyan-400/[0.08] text-cyan-50'

  return (
    <div className={`rounded-[24px] border px-4 py-4 text-sm leading-6 ${classes}`}>
      <p>{message}</p>
    </div>
  )
}

function FloatingZipButton({ count, disabled, isSaving, onClick }: { count: number; disabled: boolean; isSaving: boolean; onClick: () => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-40 flex justify-end sm:inset-x-auto sm:right-6 sm:bottom-6">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="pointer-events-auto inline-flex w-full items-center justify-center gap-3 rounded-full border border-rose-300/20 bg-rose-950/82 px-5 py-4 text-sm font-medium text-rose-50 shadow-[0_20px_70px_rgba(2,6,23,0.5)] backdrop-blur transition hover:border-rose-200/40 hover:bg-rose-900/82 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/60 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-slate-900/88 disabled:text-slate-400 sm:w-auto sm:min-w-[220px]"
        title={disabled ? 'Marque pelo menos um XML para gerar o ZIP.' : 'Salvar os XMLs marcados em um arquivo ZIP.'}
      >
        <FileArchive className="size-5" />
        <span>{isSaving ? 'Salvando ZIP...' : 'Salvar ZIP'}</span>
        <span className="rounded-full border border-white/10 bg-white/10 px-2 py-0.5 text-xs font-semibold">{count}</span>
      </button>
    </div>
  )
}

function CheckboxShell({ checked, label, onCheckedChange }: { checked: CheckedState; label: string; onCheckedChange: (checked: CheckedState) => void }) {
  return (
    <Checkbox.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-slate-950/85 text-cyan-100 transition hover:border-cyan-300/50 hover:bg-cyan-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 data-[state=checked]:border-cyan-300/50 data-[state=checked]:bg-cyan-400/15 data-[state=indeterminate]:border-cyan-300/50 data-[state=indeterminate]:bg-cyan-400/15"
    >
      <Checkbox.Indicator>
        {checked === 'indeterminate' ? <Minus className="size-4" /> : <Check className="size-4" />}
      </Checkbox.Indicator>
    </Checkbox.Root>
  )
}

function RangePicker({ value, onChange }: { value: DateRange | undefined; onChange: (next: DateRange | undefined) => void }) {
  const [open, setOpen] = useState(false)
  const [hoveredDay, setHoveredDay] = useState<Date | undefined>()

  const awaitingEndDate = Boolean(value?.from && !value?.to)
  const previewRange = useMemo(() => {
    if (!value?.from || value.to || !hoveredDay) {
      return undefined
    }

    return hoveredDay.getTime() < value.from.getTime()
      ? { from: hoveredDay, to: value.from }
      : { from: value.from, to: hoveredDay }
  }, [hoveredDay, value])

  const helperText = awaitingEndDate
    ? 'Selecione a data final do intervalo.'
    : value?.from && value?.to
      ? 'Intervalo definido. Clique em uma nova data para recomecar a selecao.'
      : 'Selecione a data inicial do intervalo.'

  const handleSelect = (next: DateRange | undefined) => {
    onChange(next)
    setHoveredDay(undefined)

    if (next?.from && next?.to) {
      window.setTimeout(() => setOpen(false), 0)
    }
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setHoveredDay(undefined)
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-900/80 px-4 py-3 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition hover:border-cyan-300/35 hover:bg-slate-900"
        >
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{awaitingEndDate ? 'Selecionando data final' : 'Periodo selecionado'}</p>
            <p className="mt-1 text-sm font-medium text-white">{formatRange(value)}</p>
          </div>
          <CalendarDays className="size-4 text-cyan-200" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={12}
          onMouseLeave={() => setHoveredDay(undefined)}
          className="z-50 w-[min(92vw,348px)] rounded-[28px] border border-white/10 bg-slate-950/95 p-4 shadow-[0_30px_80px_rgba(2,6,23,0.8)] backdrop-blur"
        >
          <div className="mb-4 rounded-[22px] border border-white/10 bg-white/[0.04] px-4 py-3">
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Selecao do intervalo</p>
            <p className="mt-2 text-sm font-medium text-white">{formatRange(value)}</p>
            <p className="mt-2 text-xs leading-5 text-cyan-100/75">{helperText}</p>
          </div>
          <DayPicker
            mode="range"
            resetOnSelect
            locale={ptBR}
            selected={value}
            onSelect={handleSelect}
            onDayMouseEnter={(day) => {
              if (value?.from && !value?.to) {
                setHoveredDay(day)
              }
            }}
            showOutsideDays
            fixedWeeks
            className="w-full"
            modifiers={{
              preview: previewRange,
              preview_start: previewRange?.from,
              preview_end: previewRange?.to,
            }}
            modifiersClassNames={{
              preview: 'rdp-preview-range',
              preview_start: 'rdp-preview-start',
              preview_end: 'rdp-preview-end',
            }}
            classNames={{
              months: 'flex flex-col gap-4',
              month: 'space-y-4',
              caption: 'flex items-center justify-between px-1 text-sm text-white',
              caption_label: 'text-sm font-semibold capitalize',
              nav: 'flex items-center gap-1',
              button_previous:
                'inline-flex size-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-slate-200 transition hover:border-cyan-300/35 hover:bg-cyan-400/10',
              button_next:
                'inline-flex size-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-slate-200 transition hover:border-cyan-300/35 hover:bg-cyan-400/10',
              month_grid: 'w-full border-collapse',
              weekdays: 'grid grid-cols-7 gap-x-0 gap-y-1 text-xs uppercase tracking-[0.18em] text-slate-500',
              weekday: 'flex h-9 items-center justify-center font-medium',
              week: 'mt-1 grid grid-cols-7 gap-x-0 gap-y-1',
              day: 'rdp-day-shell flex items-center justify-center py-0.5',
              day_button:
                'rdp-day-chip flex h-11 w-full items-center justify-center rounded-full border border-transparent text-sm text-slate-200 transition hover:border-cyan-300/35 hover:bg-cyan-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70',
              selected:
                'text-white hover:border-cyan-200/60 hover:bg-cyan-300/25',
              range_start: 'rdp-range-start-shell text-white',
              range_end: 'rdp-range-end-shell text-white',
              range_middle: 'rdp-range-middle-shell text-cyan-50',
              today: 'text-white',
              outside: 'text-slate-600',
              disabled: 'text-slate-700',
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function EmptyState({ title, description, actionLabel, onAction }: { title: string; description: string; actionLabel: string; onAction: () => void }) {
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center rounded-[28px] border border-dashed border-white/12 bg-white/[0.02] px-6 text-center">
      <div className="flex size-16 items-center justify-center rounded-3xl border border-cyan-300/20 bg-cyan-400/10 text-cyan-100">
        <Search className="size-6" />
      </div>
      <h3 className="mt-6 text-xl font-semibold text-white">{title}</h3>
      <p className="mt-3 max-w-md text-sm leading-6 text-slate-400">{description}</p>
      <div className="mt-6">
        <ActionButton variant="secondary" onClick={onAction} icon={<Sparkles className="size-4" />}>
          {actionLabel}
        </ActionButton>
      </div>
    </div>
  )
}

function ContextMenuButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-white/[0.08]"
    >
      {children}
    </button>
  )
}

type ConfigDialogProps = {
  open: boolean
  onOpenChange: (next: boolean) => void
  configPath: string
  onConfigPathChange: (value: string) => void
  startupInfo: StartupState | null
  lines: string[]
  validationResult: ValidationResult | null
  isBusy: boolean
  bridgeReady: boolean
  onApplySuggestion: () => void
  onChoosePath: () => void
  onDetectFromDanfe: () => void
  onDetectDefault: () => void
  onTestStructure: () => void
  onSave: () => void
}

function ConfigDialog({
  open,
  onOpenChange,
  configPath,
  onConfigPathChange,
  startupInfo,
  lines,
  validationResult,
  isBusy,
  bridgeReady,
  onApplySuggestion,
  onChoosePath,
  onDetectFromDanfe,
  onDetectDefault,
  onTestStructure,
  onSave,
}: ConfigDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/82 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(94vw,920px)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-[32px] border border-white/10 bg-slate-950/96 p-6 shadow-[0_30px_120px_rgba(2,6,23,0.82)] outline-none sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-2xl font-semibold text-white">Configuracao do UniNFe</Dialog.Title>
              <Dialog.Description className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
                A deteccao automatica entra primeiro pelo DANFE.ini, depois pela busca padrao nos discos. A escolha manual continua disponivel para reduzir chance de bloqueio no primeiro uso.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="inline-flex size-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-slate-200 transition hover:border-cyan-300/40 hover:bg-cyan-400/10 hover:text-cyan-50"
                aria-label="Fechar configuracao"
              >
                <X className="size-5" />
              </button>
            </Dialog.Close>
          </div>

          <div className="mt-6 grid gap-5 xl:grid-cols-[1.25fr_0.95fr]">
            <div className="space-y-4">
              {!bridgeReady && (
                <div className="rounded-[24px] border border-amber-300/18 bg-amber-400/[0.08] px-4 py-3 text-sm leading-6 text-amber-50">
                  O backend nativo ainda esta conectando. A interface ja pode ser navegada, mas as acoes de configuracao vao liberar assim que essa etapa terminar.
                </div>
              )}
              {startupInfo && startupInfo.mode !== 'saved' && (
                <div className="rounded-[28px] border border-cyan-300/15 bg-cyan-400/[0.06] p-5 text-sm leading-6 text-slate-300">
                  <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-cyan-100">
                    <Sparkles className="size-3.5" />
                    {startupInfo.title}
                  </div>
                  <p className="mt-4 text-slate-300">{startupInfo.message}</p>
                  {startupInfo.path && (
                    <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 font-mono text-[13px] text-slate-200">
                      {startupInfo.path}
                    </div>
                  )}
                  {startupInfo.path && (
                    <div className="mt-4">
                      <ActionButton variant="secondary" onClick={onApplySuggestion} icon={<Save className="size-4" />} disabled={!bridgeReady || isBusy}>
                        Usar caminho sugerido
                      </ActionButton>
                    </div>
                  )}
                </div>
              )}

              <label className="block space-y-2">
                <span className="text-sm font-medium text-slate-200">Pasta base do Unimake</span>
                <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-900/80 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                  <HardDrive className="size-4 text-slate-500" />
                  <input
                    value={configPath}
                    onChange={(event) => onConfigPathChange(event.target.value)}
                    className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-500"
                    placeholder="C:\\Unimake ou \\\\servidor\\unimake"
                  />
                </div>
              </label>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-2">
                <ActionButton variant="secondary" onClick={onChoosePath} icon={<FolderOpen className="size-4" />} disabled={!bridgeReady || isBusy}>
                  Selecionar pasta
                </ActionButton>
                <ActionButton variant="secondary" onClick={onDetectFromDanfe} icon={<FolderSearch className="size-4" />} disabled={!bridgeReady || isBusy}>
                  Buscar DANFE.ini
                </ActionButton>
                <ActionButton variant="secondary" onClick={onDetectDefault} icon={<ScanSearch className="size-4" />} disabled={!bridgeReady || isBusy}>
                  Buscar caminhos padrao
                </ActionButton>
                <ActionButton variant="secondary" onClick={onTestStructure} icon={<ShieldCheck className="size-4" />} disabled={!bridgeReady || isBusy}>
                  Testar estrutura
                </ActionButton>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-[28px] border border-white/10 bg-white/[0.03] p-5 text-sm leading-6 text-slate-300">
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-slate-300">
                  <ShieldCheck className="size-3.5" />
                  Resumo
                </div>
                <div className="mt-4 space-y-3">
                  <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Caminho atual</p>
                    <p className="mt-2 break-all text-sm text-white">{configPath || 'Nao definido'}</p>
                  </div>
                  <div className={`rounded-2xl border px-4 py-3 ${validationResult ? validationResult.ok ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-50' : 'border-rose-400/18 bg-rose-400/10 text-rose-50' : 'border-white/10 bg-white/[0.04] text-slate-200'}`}>
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Ultima validacao</p>
                    <p className="mt-2 text-sm">{validationResult?.message || 'Nenhum teste executado ainda.'}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-[28px] border border-white/10 bg-slate-950/72 p-5">
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-slate-300">
                  <Logs className="size-3.5" />
                  Diagnostico
                </div>
                <div className="mt-4 max-h-[320px] overflow-auto rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 font-mono text-[13px] leading-6 text-slate-300">
                  {lines.length === 0 ? <p className="text-slate-500">Nenhum detalhe disponivel ainda.</p> : lines.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
            >
              Fechar
            </button>
            <ActionButton variant="orange" onClick={onSave} icon={<Save className="size-4" />} disabled={!bridgeReady || isBusy || !configPath.trim()}>
              Salvar caminho
            </ActionButton>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function createCurrentMonthRange(reference: Date): DateRange {
  return {
    from: startOfMonth(reference),
    to: endOfMonth(reference),
  }
}

function createPreviousMonthRange(reference: Date): DateRange {
  const previousMonth = subMonths(reference, 1)
  return {
    from: startOfMonth(previousMonth),
    to: endOfMonth(previousMonth),
  }
}

function formatRange(range: DateRange | undefined) {
  if (!range?.from && !range?.to) {
    return 'Sem restricao de data'
  }

  if (range?.from && range?.to) {
    return `${format(range.from, 'dd/MM/yyyy', { locale: ptBR })} ate ${format(range.to, 'dd/MM/yyyy', { locale: ptBR })}`
  }

  if (range?.from) {
    return `A partir de ${format(range.from, 'dd/MM/yyyy', { locale: ptBR })}`
  }

  return `Ate ${format(range.to!, 'dd/MM/yyyy', { locale: ptBR })}`
}

function parseLastSearchRange(value: LastSearchState): DateRange | null {
  if (!value?.startDate || !value?.endDate) {
    return null
  }

  return {
    from: parseISO(value.startDate),
    to: parseISO(value.endDate),
  }
}

function formatLastSearchRange(range: DateRange | null) {
  if (!range?.from || !range?.to) {
    return 'Nenhuma busca feita ainda'
  }

  return formatRange(range)
}

function findXmlSearchMatches(source: string, query: string) {
  if (!query) {
    return []
  }

  const normalizedSource = source.toLocaleLowerCase()
  const normalizedQuery = query.toLocaleLowerCase()
  const matches: Array<{ start: number; end: number }> = []
  let searchIndex = 0

  while (searchIndex < normalizedSource.length) {
    const matchIndex = normalizedSource.indexOf(normalizedQuery, searchIndex)
    if (matchIndex === -1) {
      break
    }

    matches.push({ start: matchIndex, end: matchIndex + normalizedQuery.length })
    searchIndex = matchIndex + normalizedQuery.length
  }

  return matches
}

function buildHighlightedXml(source: string, matches: Array<{ start: number; end: number }>): XmlHighlightPart[] {
  if (matches.length === 0) {
    return [{ text: source, matchIndex: null }]
  }

  const parts: XmlHighlightPart[] = []
  let cursor = 0

  matches.forEach((match, index) => {
    if (match.start > cursor) {
      parts.push({ text: source.slice(cursor, match.start), matchIndex: null })
    }

    parts.push({
      text: source.slice(match.start, match.end),
      matchIndex: index,
    })
    cursor = match.end
  })

  if (cursor < source.length) {
    parts.push({ text: source.slice(cursor), matchIndex: null })
  }

  return parts
}

function formatIsoDate(value: Date) {
  return format(value, 'yyyy-MM-dd')
}

function formatIssuedDate(value: string | null) {
  if (!value) {
    return '-'
  }
  return format(parseISO(value), 'dd/MM/yyyy', { locale: ptBR })
}

function groupNotes(notes: BackendNote[]): CompanyGroup[] {
  const companyMap = new Map<string, Map<string, BackendNote[]>>()

  notes.forEach((note) => {
    const companyModels = companyMap.get(note.cnpj) ?? new Map<string, BackendNote[]>()
    const modelNotes = companyModels.get(note.docType) ?? []
    modelNotes.push(note)
    companyModels.set(note.docType, modelNotes)
    companyMap.set(note.cnpj, companyModels)
  })

  return [...companyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cnpj, models]) => ({
      id: `company-${cnpj}`,
      cnpj,
      models: [...models.entries()]
        .sort(([a], [b]) => compareModelLabels(a, b))
        .map(([label, modelNotes]) => ({
          id: `model-${cnpj}-${label}`,
          label,
          notes: [...modelNotes].sort(compareNotes),
        })),
    }))
}

function compareNotes(left: BackendNote, right: BackendNote) {
  const leftDate = left.issueDate ? parseISO(left.issueDate).getTime() : 0
  const rightDate = right.issueDate ? parseISO(right.issueDate).getTime() : 0
  if (leftDate !== rightDate) {
    return leftDate - rightDate
  }

  const leftNumber = Number.parseInt(left.number, 10)
  const rightNumber = Number.parseInt(right.number, 10)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber
  }

  return left.accessKey.localeCompare(right.accessKey)
}


function compareModelLabels(left: string, right: string) {
  const leftRank = MODEL_ORDER[left] ?? Number.MAX_SAFE_INTEGER
  const rightRank = MODEL_ORDER[right] ?? Number.MAX_SAFE_INTEGER
  if (leftRank !== rightRank) {
    return leftRank - rightRank
  }

  return left.localeCompare(right)

}
function buildExpansionDefaults() {
  return {
    companyIds: new Set<string>(),
    modelIds: new Set<string>(),
  }
}

function deriveCheckedState(ids: string[], selected: Set<string>): CheckedState {
  const checkedCount = ids.filter((id) => selected.has(id)).length
  if (checkedCount === 0) {
    return false
  }
  if (checkedCount === ids.length) {
    return true
  }
  return 'indeterminate'
}

function resizeAdjacentColumns(weights: Record<NoteColumnKey, number>, columnKey: NoteColumnKey, nextColumnKey: NoteColumnKey, deltaWeight: number) {
  const maxPositiveDelta = Math.min(
    NOTE_COLUMN_MAX_WEIGHTS[columnKey] - weights[columnKey],
    weights[nextColumnKey] - NOTE_COLUMN_MIN_WEIGHTS[nextColumnKey],
  )
  const maxNegativeDelta = Math.max(
    NOTE_COLUMN_MIN_WEIGHTS[columnKey] - weights[columnKey],
    weights[nextColumnKey] - NOTE_COLUMN_MAX_WEIGHTS[nextColumnKey],
  )
  const safeDelta = clamp(deltaWeight, maxNegativeDelta, maxPositiveDelta)

  return {
    ...weights,
    [columnKey]: clamp(weights[columnKey] + safeDelta, NOTE_COLUMN_MIN_WEIGHTS[columnKey], NOTE_COLUMN_MAX_WEIGHTS[columnKey]),
    [nextColumnKey]: clamp(weights[nextColumnKey] - safeDelta, NOTE_COLUMN_MIN_WEIGHTS[nextColumnKey], NOTE_COLUMN_MAX_WEIGHTS[nextColumnKey]),
  }
}

function addSetValue(current: Set<string>, id: string) {
  const next = new Set(current)
  next.add(id)
  return next
}

function removeSetValue(current: Set<string>, id: string) {
  const next = new Set(current)
  next.delete(id)
  return next
}

function trimLogs(lines: string[]) {
  return lines.slice(-500)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export default App




































