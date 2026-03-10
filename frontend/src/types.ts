export type BackendNote = {
  id: string
  docType: string
  cnpj: string
  accessKey: string
  number: string
  series: string
  issueDate: string | null
  fileName: string
}

export type ConfigState = {
  basePath: string
  hasSavedPath: boolean
}

export type StartupState = {
  mode: 'loading' | 'saved' | 'suggestion' | 'manual-required'
  shouldPromptConfig: boolean
  title: string
  message: string
  path: string
  lines: string[]
  source?: 'danfe' | 'default-search' | 'manual'
}

export type InitialState = {
  ok: boolean
  appTitle: string
  config: ConfigState
  defaults: {
    startDate: string
    endDate: string
  }
  startup: StartupState
  validation: ValidationResult | null
}

export type StartupContextResult = {
  ok: boolean
  config: ConfigState
  startup: StartupState
  validation: ValidationResult | null
}

export type ValidationResult = {
  ok: boolean
  path: string
  lines: string[]
  message: string
}

export type DetectionResult = {
  ok: boolean
  path: string
  source: 'danfe' | 'default-search'
  message: string
  lines: string[]
  structureOk?: boolean
}

export type ChoosePathResult = {
  ok: boolean
  cancelled?: boolean
  path?: string
  message: string
}

export type SaveConfigResult = {
  ok: boolean
  path: string
  message: string
}

export type ScanStartRequest = {
  basePath: string
  startDate: string
  endDate: string
}

export type ScanStartResult = {
  ok: boolean
  jobId?: string
  message?: string
}

export type ScanJobSnapshot = {
  ok: true
  jobId: string
  status: 'running' | 'completed' | 'error'
  progressText: string
  logs: string[]
  stats: {
    cnpjs: number
    xml_lidos: number
    notas_no_periodo: number
  }
  notes: BackendNote[]
  error: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export type SaveZipRequest = {
  noteIds: string[]
  startDate: string
  endDate: string
}

export type SaveZipResult = {
  ok: boolean
  cancelled?: boolean
  message: string
  targetPath?: string
  added?: number
  missing?: number
}

export type ActionResult = {
  ok: boolean
  cancelled?: boolean
  message: string
  targetPath?: string
}

export type DesktopBridge = {
  getInitialState: () => Promise<InitialState>
  loadStartupContext: () => Promise<StartupContextResult>
  chooseBasePath: (currentPath?: string) => Promise<ChoosePathResult>
  saveBasePath: (basePath: string) => Promise<SaveConfigResult>
  detectFromDanfe: () => Promise<DetectionResult>
  detectDefaultBase: () => Promise<DetectionResult>
  testStructure: (basePath: string) => Promise<ValidationResult>
  startScan: (request: ScanStartRequest) => Promise<ScanStartResult>
  getScanJob: (jobId: string) => Promise<ScanJobSnapshot | { ok: false; message: string }>
  saveSelectedZip: (request: SaveZipRequest) => Promise<SaveZipResult>
  saveNoteCopy: (noteId: string) => Promise<ActionResult>
  openNoteLocation: (noteId: string) => Promise<ActionResult>
}
