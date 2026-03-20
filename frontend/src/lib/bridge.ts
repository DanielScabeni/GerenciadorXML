import type {
  ActionResult,
  BackendNote,
  ChoosePathResult,
  DesktopBridge,
  DetectionResult,
  InitialState,
  NotePreviewResult,
  SaveConfigResult,
  SaveZipRequest,
  SaveZipResult,
  ScanJobSnapshot,
  ScanStartRequest,
  ScanStartResult,
  StartupContextResult,
  ValidationResult,
} from '../types'

declare global {
  interface Window {
    pywebview?: {
      api?: Record<string, (...args: unknown[]) => Promise<unknown>>
    }
  }
}

const ENABLE_MOCK_BRIDGE = import.meta.env.DEV || new URLSearchParams(window.location.search).has('mock')
const REQUIRED_API_METHODS = ['get_initial_state', 'load_startup_context']

const mockNotes: BackendNote[] = [
  {
    id: 'NF-e|00082490001545|35260300082490001545550010000145821045670011',
    docType: 'NF-e',
    cnpj: '00082490001545',
    accessKey: '35260300082490001545550010000145821045670011',
    number: '14582',
    series: '1',
    issueDate: '2026-03-02',
    fileName: 'procNFe_14582.xml',
  },
  {
    id: 'NFC-e|00082490001545|35260300082490001546550030000880121098234010',
    docType: 'NFC-e',
    cnpj: '00082490001545',
    accessKey: '35260300082490001546550030000880121098234010',
    number: '88012',
    series: '3',
    issueDate: '2026-03-03',
    fileName: 'procNFCe_88012.xml',
  },
  {
    id: 'CT-e|05652844001300|35260305652844001302550020000099811044553366',
    docType: 'CT-e',
    cnpj: '05652844001300',
    accessKey: '35260305652844001302550020000099811044553366',
    number: '9981',
    series: '2',
    issueDate: '2026-03-05',
    fileName: 'procCTe_9981.xml',
  },
]

let mockBasePath = 'C:\\Unimake'
let mockLastSearch: { startDate: string; endDate: string } | null = null
let mockJob: ScanJobSnapshot | null = null
let cachedBridge: Promise<DesktopBridge> | null = null

export async function getDesktopBridge(): Promise<DesktopBridge> {
  if (cachedBridge) {
    return cachedBridge
  }

  cachedBridge = createDesktopBridge().catch((error) => {
    cachedBridge = null
    throw error
  })

  return cachedBridge
}

async function createDesktopBridge(): Promise<DesktopBridge> {
  const pywebviewApi = await waitForPywebviewApi(ENABLE_MOCK_BRIDGE ? 1500 : 8000)
  if (pywebviewApi) {
    return {
      getInitialState: () => callApi<InitialState>(pywebviewApi, 'get_initial_state'),
      loadStartupContext: () => callApi<StartupContextResult>(pywebviewApi, 'load_startup_context'),
      chooseBasePath: (currentPath?: string) => callApi<ChoosePathResult>(pywebviewApi, 'choose_base_path', currentPath ?? ''),
      saveBasePath: (basePath: string) => callApi<SaveConfigResult>(pywebviewApi, 'save_base_path', basePath),
      detectFromDanfe: () => callApi<DetectionResult>(pywebviewApi, 'detect_from_danfe'),
      detectDefaultBase: () => callApi<DetectionResult>(pywebviewApi, 'detect_default_base'),
      testStructure: (basePath: string) => callApi<ValidationResult>(pywebviewApi, 'test_structure', basePath),
      startScan: (request: ScanStartRequest) => callApi<ScanStartResult>(pywebviewApi, 'start_scan', request),
      getScanJob: (jobId: string) => callApi<ScanJobSnapshot | { ok: false; message: string }>(pywebviewApi, 'get_scan_job', jobId),
      saveSelectedZip: (request: SaveZipRequest) => callApi<SaveZipResult>(pywebviewApi, 'save_selected_zip', request),
      saveNoteCopy: (noteId: string) => callApi<ActionResult>(pywebviewApi, 'save_note_copy', noteId),
      openNoteLocation: (noteId: string) => callApi<ActionResult>(pywebviewApi, 'open_note_location', noteId),
      getNoteXmlPreview: (noteId: string) => callApi<NotePreviewResult>(pywebviewApi, 'get_note_xml_preview', noteId),
    }
  }

  if (ENABLE_MOCK_BRIDGE) {
    return createMockBridge()
  }

  throw new Error(`Nao foi possivel conectar a interface ao backend nativo. ${describeBridgeDiagnostics()}`)
}

function waitForPywebviewApi(timeoutMs: number): Promise<Record<string, (...args: unknown[]) => Promise<unknown>> | null> {
  return new Promise((resolve) => {
    let settled = false

    const finish = (api: Record<string, (...args: unknown[]) => Promise<unknown>> | null) => {
      if (settled) {
        return
      }

      settled = true
      window.clearTimeout(timeout)
      window.clearInterval(poll)
      window.removeEventListener('pywebviewready', onReady)
      resolve(api)
    }

    const check = () => {
      const api = window.pywebview?.api
      if (api && hasRequiredApi(api)) {
        finish(api)
      }
    }

    const onReady = () => {
      check()
    }

    const poll = window.setInterval(check, 150)
    const timeout = window.setTimeout(() => finish(null), timeoutMs)
    window.addEventListener('pywebviewready', onReady, { once: true })
    check()
  })
}

function hasRequiredApi(api: Record<string, (...args: unknown[]) => Promise<unknown>>) {
  return REQUIRED_API_METHODS.every((methodName) => !!resolveApiMethod(api, methodName))
}

function resolveApiMethod(api: Record<string, (...args: unknown[]) => Promise<unknown>>, methodName: string) {
  const direct = api[methodName]
  if (typeof direct === 'function') {
    return direct
  }

  const camelCase = toCamelCase(methodName)
  const camel = api[camelCase]
  if (typeof camel === 'function') {
    return camel
  }

  return null
}

function callApi<T>(api: Record<string, (...args: unknown[]) => Promise<unknown>>, methodName: string, ...args: unknown[]) {
  const method = resolveApiMethod(api, methodName)
  if (!method) {
    const availableMethods = Object.keys(api).sort().join(', ') || '(nenhum metodo exposto)'
    throw new Error(`Metodo ${methodName} nao foi exposto pela API nativa. Disponiveis: ${availableMethods}`)
  }

  return method(...args) as Promise<T>
}

function toCamelCase(value: string) {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

function describeBridgeDiagnostics() {
  const pywebview = window.pywebview
  const api = pywebview?.api
  const apiKeys = api ? Object.keys(api).sort() : []

  if (!pywebview) {
    return 'A camada JavaScript do pywebview nao apareceu na pagina.'
  }

  if (!api) {
    return 'O objeto window.pywebview existe, mas a API nativa ainda nao foi criada.'
  }

  if (apiKeys.length === 0) {
    return 'A API nativa foi criada vazia; nenhum metodo ficou disponivel ainda.'
  }

  return `Metodos detectados na API: ${apiKeys.join(', ')}`
}

function createMockBridge(): DesktopBridge {
  return {
    async getInitialState() {
      const defaults = getMockPreviousMonthDefaults()
      return {
        ok: true,
        appTitle: 'Gerenciador de XML',
        config: {
          basePath: mockBasePath,
          hasSavedPath: true,
        },
        defaults: {
          startDate: defaults.startDate,
          endDate: defaults.endDate,
        },
        startup: {
          mode: 'loading',
          shouldPromptConfig: false,
          title: 'Carregando configuracao',
          message: 'Preparando a interface de demonstracao.',
          path: mockBasePath,
          lines: [],
        },
        validation: null,
        lastSearch: mockLastSearch,
      }
    },
    async loadStartupContext() {
      return {
        ok: true,
        config: {
          basePath: mockBasePath,
          hasSavedPath: true,
        },
        startup: {
          mode: 'saved',
          shouldPromptConfig: false,
          title: 'Modo demonstracao',
          message: 'Bridge pywebview indisponivel. Usando dados simulados para desenvolvimento.',
          path: mockBasePath,
          lines: ['[INFO] Rodando em modo demonstracao no navegador.'],
        },
        validation: {
          ok: true,
          path: mockBasePath,
          message: 'Estrutura simulada validada.',
          lines: ['[OK] Estrutura simulada pronta para desenvolvimento.'],
        },
        lastSearch: mockLastSearch,
      }
    },
    async chooseBasePath() {
      return {
        ok: true,
        path: mockBasePath,
        message: 'Modo demonstracao: mantendo o caminho simulado.',
      }
    },
    async saveBasePath(basePath: string) {
      mockBasePath = basePath
      return {
        ok: true,
        path: mockBasePath,
        message: 'Configuracao simulada salva.',
      }
    },
    async detectFromDanfe() {
      return {
        ok: true,
        path: mockBasePath,
        source: 'danfe',
        message: 'Modo demonstracao: caminho encontrado pelo DANFE.ini simulado.',
        lines: ['[OK] DANFE.ini simulado encontrado.', `[INFO] PastaUniNFE lida: ${mockBasePath}\\UniNFe`],
        structureOk: true,
      }
    },
    async detectDefaultBase() {
      return {
        ok: true,
        path: mockBasePath,
        source: 'default-search',
        message: 'Modo demonstracao: caminho encontrado pela busca padrao simulada.',
        lines: ['[INFO] Candidato simulado encontrado em C:\\Unimake'],
        structureOk: true,
      }
    },
    async testStructure(basePath: string) {
      return {
        ok: true,
        path: basePath,
        message: 'Estrutura simulada validada.',
        lines: ['[OK] NF-e: 2 CNPJ(s), 2 com Enviado/Autorizados.', '[OK] NFC-e: 1 CNPJ(s), 1 com Enviado/Autorizados.'],
      }
    },
    async startScan(request: ScanStartRequest) {
      const jobId = `mock-${Date.now()}`
      mockJob = {
        ok: true,
        jobId,
        status: 'running',
        progressText: 'Preparando busca simulada...',
        period: {
          startDate: request.startDate,
          endDate: request.endDate,
        },
        logs: [`[INFO] Busca simulada iniciada em ${request.basePath}`],
        stats: {
          cnpjs: 0,
          xml_lidos: 0,
          notas_no_periodo: 0,
        },
        notes: [],
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: null,
      }

      window.setTimeout(() => {
        if (!mockJob || mockJob.jobId !== jobId) {
          return
        }

        mockLastSearch = {
          startDate: request.startDate,
          endDate: request.endDate,
        }

        mockJob = {
          ...mockJob,
          status: 'completed',
          progressText: 'Busca simulada concluida.',
          logs: [
            ...mockJob.logs,
            '[NF-e] 2 CNPJ(s) encontrados.',
            '[NF-e] -> varrendo: C:\\Unimake\\UniNFe\\00082490001545\\Enviado\\Autorizados\\202603',
            'Leitura finalizada. XMLs lidos: 3. Notas no periodo: 3.',
          ],
          stats: {
            cnpjs: 3,
            xml_lidos: 3,
            notas_no_periodo: 3,
          },
          notes: mockNotes,
          updatedAt: Date.now(),
          completedAt: Date.now(),
        }
      }, 900)

      return { ok: true, jobId }
    },
    async getScanJob(jobId: string) {
      if (!mockJob || mockJob.jobId !== jobId) {
        return { ok: false as const, message: 'Busca simulada nao encontrada.' }
      }
      return mockJob
    },
    async saveSelectedZip(request: SaveZipRequest) {
      return {
        ok: true,
        message: `Modo demonstracao: ZIP simulado com ${request.noteIds.length} XML(s).`,
        targetPath: 'C:\\Temp\\XML demonstracao.zip',
        added: request.noteIds.length,
        missing: 0,
      }
    },
    async saveNoteCopy(noteId: string) {
      return {
        ok: true,
        message: `Modo demonstracao: XML ${noteId} salvo de forma simulada.`,
        targetPath: 'C:\\Temp\\XML_demonstracao.xml',
      }
    },
    async openNoteLocation() {
      return {
        ok: true,
        message: 'Modo demonstracao: local do arquivo aberto de forma simulada.',
      }
    },
    async getNoteXmlPreview(noteId: string) {
      const note = mockNotes.find((item) => item.id === noteId)
      if (!note) {
        return {
          ok: false,
          message: 'Nota simulada nao encontrada.',
        }
      }

      const xmlText = [
        '<?xml version="1.0" encoding="utf-8"?>',
        `<documento tipo="${note.docType}">`,
        `  <cnpj>${note.cnpj}</cnpj>`,
        `  <numero>${note.number}</numero>`,
        `  <serie>${note.series}</serie>`,
        `  <chave>${note.accessKey}</chave>`,
        `  <arquivo>${note.fileName}</arquivo>`,
        '</documento>',
      ].join('\\n')

      return {
        ok: true,
        message: 'XML simulado carregado.',
        fileName: note.fileName,
        xmlText,
      }
    },
  }
}

function getMockPreviousMonthDefaults() {
  const today = new Date()
  const firstDayCurrentMonth = new Date(today.getFullYear(), today.getMonth(), 1)
  const lastDayPreviousMonth = new Date(firstDayCurrentMonth.getTime() - 24 * 60 * 60 * 1000)
  const firstDayPreviousMonth = new Date(lastDayPreviousMonth.getFullYear(), lastDayPreviousMonth.getMonth(), 1)

  return {
    startDate: formatDateForBridge(firstDayPreviousMonth),
    endDate: formatDateForBridge(lastDayPreviousMonth),
  }
}

function formatDateForBridge(date: Date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}


