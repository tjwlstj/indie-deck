/**
 * @indiedeck/core - engine detection, compatibility resolution and installation.
 *
 * The launcher UI and CLI are thin shells over this package; everything that
 * decides *what* to install for *which* game lives here.
 */

export * from './types.ts';

export {
  t,
  tRegistry,
  message,
  retranslate,
  setLocale,
  getLocale,
  detectSystemLocale,
  normaliseLocale,
  availableLocales,
  getCatalog,
  loadCatalogs,
  findLocalesDir,
  catalogSource,
  auditCatalogs,
  interpolate,
  hasKey,
  LOCALES,
  DEFAULT_LOCALE,
  type LocaleCode,
  type Message,
  type Catalog,
  type CatalogReport,
} from './i18n/index.ts';

export {
  findRegistryDir,
  loadRegistry,
  validateRegistry,
  engineById,
  loaderById,
  translatorById,
  loadersProviding,
  isNativeLoader,
  translatorsForEngine,
  variantOf,
  versionsForVariant,
  type RegistryIssue,
} from './registry/index.ts';

export {
  detectGame,
  scanLibrary,
  listExecutables,
  pickPrimaryExecutable,
  detectInstalledLoaders,
  detectInstalledTranslators,
  detectInstalledFontBundles,
  localiseProfile,
  type DetectOptions,
  type ScanOptions,
} from './detect/index.ts';

export { evaluateRule, scoreEngine, rankEngines } from './detect/rules.ts';
export { runProbes, type ProbeContext, type ProbeResult } from './detect/probes.ts';

export {
  readGameConfig,
  planConfigChanges,
  writeGameConfig,
  restoreConfigBackup,
  detectTranslatorVersion,
  findConfigPath,
  loadConfigSchemas,
  resolveMapping,
  providerById,
  settingById,
  type ConfigSchema,
  type GameConfig,
  type ConfigChange,
  type ConfigPlan,
  type ConfigValue,
  type ProviderDef,
  type SettingDef,
  type ValidationIssue,
  type DetectedTranslatorVersion,
} from './config/index.ts';

export { resolvePlans, summarisePlans, pickFontBundle, RULE_PREDICATES, type RulePredicate } from './resolve/index.ts';

export {
  auditGame,
  auditLibrary,
  summariseAudit,
  type AuditIssue,
  type AuditOptions,
  type GameAudit,
  type AuditSummary,
} from './audit/index.ts';

export {
  downloadAsset,
  resolveAssetUrl,
  latestReleaseTag,
  sha256,
  defaultDataDir,
  defaultCacheDir,
  defaultToolsDir,
  type DownloadOptions,
  type DownloadResult,
} from './install/download.ts';

export { extract7z, find7zExtractor, findExtractedEntry, type Extractor } from './install/sevenzip.ts';
export { extractZip, readZipEntries, readEntryData, safeJoin, type ZipEntry } from './install/unzip.ts';

export { FileTransaction, withTransaction, type TransactionOptions } from './install/transaction.ts';

export {
  applyPlan,
  normaliseReceipt,
  writeReceipt,
  readReceipts,
  uninstallReceipt,
  RECEIPT_DIR,
  BACKUP_DIR,
  type ApplyOptions,
  type ApplyResult,
  type UninstallResult,
  type UninstallOptions,
} from './install/apply.ts';

export {
  listMods,
  modHosts,
  setModEnabled,
  installModFromFile,
  parsePluginsJs,
  setPluginStatus,
  appendPlugin,
  type ModEntry,
  type ModHost,
  type ModLayout,
} from './mods/index.ts';

export {
  loadConfig,
  saveConfig,
  addRoot,
  removeRoot,
  loadLibrary,
  saveLibrary,
  refreshLibrary,
  findGames,
  resolveGameArg,
  libraryStats,
  configPath,
  libraryPath,
  type LauncherConfig,
  type LibraryIndex,
  type LibraryStats,
} from './library/index.ts';

export { FsProbe, matchesGlob, globToRegExp, dirSize, ensureDir, pathExists } from './util/fsx.ts';
export { compareVersions, parseVersion, gte, lt, satisfiesRange, unityMajor } from './util/version.ts';
export { peArch, peArchFromBuffer, peVersionString } from './util/pe.ts';
export { parseIni, applyIni, type IniData } from './util/ini.ts';
export { createLogger, silentLogger, type Logger, type LogLevel } from './util/log.ts';
