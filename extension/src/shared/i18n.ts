export type LocaleSetting = 'auto' | 'zh-CN' | 'en' | 'zh-TW' | 'ja';
export type ResolvedLocale = 'zh-CN' | 'en' | 'zh-TW' | 'ja';

export const LOCALE_OPTIONS: ReadonlyArray<{ value: LocaleSetting; label: string }> = [
  { value: 'auto', label: 'Auto (System)' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'ja', label: '日本語' },
];

export function isLocaleSetting(value: unknown): value is LocaleSetting {
  return value === 'auto' || value === 'zh-CN' || value === 'en' || value === 'zh-TW' || value === 'ja';
}

export function resolveLocale(setting?: LocaleSetting | string, systemLanguage?: string): ResolvedLocale {
  if (setting === 'zh-CN' || setting === 'en' || setting === 'zh-TW' || setting === 'ja') {
    return setting;
  }
  const raw = (
    systemLanguage ||
    (typeof navigator !== 'undefined' ? navigator.language : '') ||
    'en'
  ).toLowerCase();
  if (raw.startsWith('zh')) {
    if (raw.includes('tw') || raw.includes('hk') || raw.includes('mo') || raw.includes('hant')) {
      return 'zh-TW';
    }
    return 'zh-CN';
  }
  if (raw.startsWith('ja')) return 'ja';
  return 'en';
}

export interface ExtensionMessages {
  globalReadOnlyBadge: string;
  allTabsBadge: string;
  connectedHost: (version: string, tag: string) => string;
  hostDisconnected: string;
  connecting: string;
  dark: string;
  light: string;
  settings: string;
  back: string;
  workerOutdated: (oldVer: string, newVer: string) => string;
  reloadNow: string;
  menuNotReady: string;
  retryMenus: string;
  hostMissing: string;
  connectionError: (err: string) => string;
  noBackgroundResponse: string;
  untitledTab: string;
  internalPageHint: string;
  sharedRo: (tabId: number) => string;
  sharedRw: (tabId: number) => string;
  switchToRw: string;
  switchToRo: string;
  globalLockActive: string;
  promptBoxTitle: string;
  promptBoxLabel: string;
  copiedShort: string;
  clickToCopy: string;
  copiedPromptBtn: string;
  copyPromptBtn: string;
  stopSharing: string;
  shareRoAndCopy: string;
  shareRw: string;
  unsharedHint: string;
  noActiveTab: string;
  otherSharedTabs: string;
  jumpToTitle: (url: string) => string;
  promptShort: string;
  removeShare: string;
  accessInUse: (owner: string) => string;
  accessShared: string;
  accessAgentOpened: string;
  languageLabel: string;
  langAuto: string;
  globalReadOnlyLabel: string;
  globalReadOnlyDesc: string;
  trustedInputLabel: string;
  trustedInputDesc: string;
  allowEvaluateLabel: string;
  allowEvaluateDesc: string;
  accessAllTabsLabel: string;
  accessAllTabsDesc: string;
  profileLabel: string;
  profilePlaceholder: string;
  activeSessions: (count: number) => string;
  noSessions: string;
  copyGuideTitle: (path: string) => string;
  copiedGuidePath: string;
  copyGuidePath: string;
  reconnect: string;
  menuShareRoCopy: string;
  menuShareRwCopy: string;
  menuSelectionCopy: string;
  menuLinkCopy: string;
  menuEnableRoOnly: string;
  menuSwitchToRw: string;
  menuSwitchToRo: string;
  menuStopShare: string;
  menuShotViewport: string;
  menuShotFullPage: string;
  toastSharedRoCopied: string;
  toastSharedRwCopied: string;
  toastEnabledRo: string;
  toastSwitchedRo: string;
  toastSwitchedRw: string;
  toastStoppedShare: string;
  toastCapturingFull: string;
  toastSavedDownloads: (fileName: string) => string;
  toastSaveFailed: (err: string) => string;
  toastShotFailed: (err: string) => string;
  toastHostTimeout: string;
}

const ZH_CN: ExtensionMessages = {
  globalReadOnlyBadge: '全局只读',
  allTabsBadge: '全标签开放',
  connectedHost: (v, tag) => `已连接宿主 v${v} · ${tag}`,
  hostDisconnected: '宿主未连接',
  connecting: '正在连接…',
  dark: '深色',
  light: '浅色',
  settings: '设置',
  back: '返回',
  workerOutdated: (oldVer, newVer) => `后台服务仍为旧版 v${oldVer}，重载后激活完整 v${newVer} 功能。`,
  reloadNow: '一键重载',
  menuNotReady: '右键菜单未就绪：请在 edge://extensions 点击 Browser Bridge 的刷新图标（↻）授予菜单权限。',
  retryMenus: '重试注册',
  hostMissing: '未检测到本地宿主注册，请运行仓库内的 scripts\\install.ps1。',
  connectionError: (err) => `连接异常：${err}`,
  noBackgroundResponse: '扩展后台未响应。',
  untitledTab: '未命名标签页',
  internalPageHint: '浏览器内部页面无法共享给 Agent，请切换到普通网页。',
  sharedRo: (id) => `只读共享 (RO) · Tab #${id}`,
  sharedRw: (id) => `读写共享 (RW) · Tab #${id}`,
  switchToRw: '切换为读写',
  switchToRo: '切换为只读',
  globalLockActive: '全局只读锁已开启',
  promptBoxTitle: '点击复制发给 Agent 的极简提示词',
  promptBoxLabel: '发给 AGENT 的提示词（含权限与本地指南）',
  copiedShort: '✓ 已复制',
  clickToCopy: '点击复制',
  copiedPromptBtn: '✓ 已复制提示词',
  copyPromptBtn: '复制 Agent 提示词',
  stopSharing: '停止共享',
  shareRoAndCopy: '只读共享 + 复制提示词',
  shareRw: '读写共享',
  unsharedHint: '只读仅允许查看结构、读取文本与后台截图；读写允许点击、填表与导航（点击后均自动复制提示词）。',
  noActiveTab: '未检测到当前活动标签页。',
  otherSharedTabs: '其他已共享页面',
  jumpToTitle: (url) => `切换到：${url}`,
  promptShort: '提示词',
  removeShare: '移除',
  accessInUse: (owner) => `${owner} 使用中`,
  accessShared: '已共享',
  accessAgentOpened: 'Agent 打开',
  languageLabel: '界面语言 (Language)',
  langAuto: '跟随浏览器 (Auto)',
  globalReadOnlyLabel: '全局只读锁（禁止任何操作与点击）',
  globalReadOnlyDesc: '开启后强制所有已共享页面进入只读状态，Agent 只能查看内容与截图，无法点击、输入或跳转。',
  trustedInputLabel: '可信键鼠与后台长截图 (CDP)',
  trustedInputDesc: '模拟真实点击并支持后台无感整页截图；启用时浏览器会显示调试横幅。',
  allowEvaluateLabel: '允许执行页面脚本 (evaluate)',
  allowEvaluateDesc: '允许 Agent 在页面内执行 JS（宿主也需带 --allow-evaluate 启动）。',
  accessAllTabsLabel: '开放全部标签页访问',
  accessAllTabsDesc: '开启后无需逐页共享，Agent 可访问当前浏览器所有标签页（请谨慎开启）。',
  profileLabel: '浏览器实例备注 (Label)',
  profilePlaceholder: '例如 Work / Trading',
  activeSessions: (n) => `活跃会话 ${n}`,
  noSessions: '暂无会话',
  copyGuideTitle: (p) => `点击复制本地指南路径：${p}`,
  copiedGuidePath: '✓ 已复制 AGENT.md 路径',
  copyGuidePath: '复制 AGENT.md 路径',
  reconnect: '重连',
  menuShareRoCopy: '只读共享并复制提示词 (RO)',
  menuShareRwCopy: '读写共享并复制提示词 (RW)',
  menuSelectionCopy: '引用选中文本复制提示词 (RO)',
  menuLinkCopy: '引用此链接复制提示词 (RO)',
  menuEnableRoOnly: '仅开启只读共享 (RO)',
  menuSwitchToRw: '切换为读写共享 (RW)',
  menuSwitchToRo: '切换为只读共享 (RO)',
  menuStopShare: '停止共享此页面',
  menuShotViewport: '截取当前视口 (保存至 Downloads)',
  menuShotFullPage: '截取整页长图 (保存至 Downloads)',
  toastSharedRoCopied: '✓ 已开启只读共享并复制 Agent 提示词',
  toastSharedRwCopied: '✓ 已开启读写共享并复制 Agent 提示词',
  toastEnabledRo: '✓ 已开启只读共享 (RO)',
  toastSwitchedRo: '✓ 已切换为只读共享 (RO)',
  toastSwitchedRw: '✓ 已切换为读写共享 (RW)',
  toastStoppedShare: '已停止共享此页面',
  toastCapturingFull: '正在截取整页长图…',
  toastSavedDownloads: (f) => `✓ 已保存至 Downloads\\${f}`,
  toastSaveFailed: (e) => `截图保存失败：${e}`,
  toastShotFailed: (e) => `截图失败：${e}`,
  toastHostTimeout: '本地宿主未响应，请检查连接。',
};

const EN: ExtensionMessages = {
  globalReadOnlyBadge: 'Read-Only',
  allTabsBadge: 'All Tabs',
  connectedHost: (v, tag) => `Connected to host v${v} · ${tag}`,
  hostDisconnected: 'Host disconnected',
  connecting: 'Connecting…',
  dark: 'Dark',
  light: 'Light',
  settings: 'Settings',
  back: 'Back',
  workerOutdated: (oldVer, newVer) => `Background worker is v${oldVer}; reload to activate v${newVer}.`,
  reloadNow: 'Reload',
  menuNotReady: 'Context menu inactive: open edge://extensions and click Reload (↻) on Browser Bridge once.',
  retryMenus: 'Retry',
  hostMissing: 'Native host is not registered. Run scripts\\install.ps1 from the repository.',
  connectionError: (err) => `Connection error: ${err}`,
  noBackgroundResponse: 'Extension background did not respond.',
  untitledTab: 'Untitled tab',
  internalPageHint: 'Browser-internal pages cannot be shared with AI agents. Switch to a web page.',
  sharedRo: (id) => `Read-Only (RO) · Tab #${id}`,
  sharedRw: (id) => `Read-Write (RW) · Tab #${id}`,
  switchToRw: 'Switch to RW',
  switchToRo: 'Switch to RO',
  globalLockActive: 'Global read-only lock active',
  promptBoxTitle: 'Click to copy minimal Agent prompt',
  promptBoxLabel: 'AGENT PROMPT (WITH MODE & LOCAL GUIDE)',
  copiedShort: '✓ Copied',
  clickToCopy: 'Click to copy',
  copiedPromptBtn: '✓ Prompt Copied',
  copyPromptBtn: 'Copy Agent Prompt',
  stopSharing: 'Unshare',
  shareRoAndCopy: 'Share Read-Only + Copy',
  shareRw: 'Share Read-Write',
  unsharedHint: 'Read-Only permits inspection, text reads, and background screenshots; Read-Write permits clicking, typing, and navigation (both copy the prompt).',
  noActiveTab: 'No active tab detected.',
  otherSharedTabs: 'Other shared tabs',
  jumpToTitle: (url) => `Switch to: ${url}`,
  promptShort: 'Prompt',
  removeShare: 'Remove',
  accessInUse: (owner) => `in use by ${owner}`,
  accessShared: 'shared',
  accessAgentOpened: 'opened by agent',
  languageLabel: 'Language',
  langAuto: 'Auto (Browser)',
  globalReadOnlyLabel: 'Global Read-Only Lock (block all actions)',
  globalReadOnlyDesc: 'Forces every shared tab into read-only mode. Agents can inspect and screenshot, never click, type, or navigate.',
  trustedInputLabel: 'Trusted Input & Background Full-Page Shots (CDP)',
  trustedInputDesc: 'Dispatches native input and background full-page screenshots; displays the browser debugging banner.',
  allowEvaluateLabel: 'Allow Page Scripts (evaluate)',
  allowEvaluateDesc: 'Permits page JavaScript execution (also requires --allow-evaluate on the host).',
  accessAllTabsLabel: 'Access All Browser Tabs',
  accessAllTabsDesc: 'Lets agents access every open tab without sharing individually (enable with caution).',
  profileLabel: 'Browser Profile Label',
  profilePlaceholder: 'e.g. Work / Trading',
  activeSessions: (n) => `Sessions: ${n}`,
  noSessions: 'Idle',
  copyGuideTitle: (p) => `Copy local guide path: ${p}`,
  copiedGuidePath: '✓ Copied AGENT.md path',
  copyGuidePath: 'Copy AGENT.md path',
  reconnect: 'Reconnect',
  menuShareRoCopy: 'Share Read-Only & Copy Prompt (RO)',
  menuShareRwCopy: 'Share Read-Write & Copy Prompt (RW)',
  menuSelectionCopy: 'Quote Selection & Copy Prompt (RO)',
  menuLinkCopy: 'Quote Link & Copy Prompt (RO)',
  menuEnableRoOnly: 'Enable Read-Only Share (RO)',
  menuSwitchToRw: 'Switch to Read-Write (RW)',
  menuSwitchToRo: 'Switch to Read-Only (RO)',
  menuStopShare: 'Stop Sharing This Tab',
  menuShotViewport: 'Capture Viewport (Save to Downloads)',
  menuShotFullPage: 'Capture Full Page (Save to Downloads)',
  toastSharedRoCopied: '✓ Shared Read-Only & copied Agent prompt',
  toastSharedRwCopied: '✓ Shared Read-Write & copied Agent prompt',
  toastEnabledRo: '✓ Enabled Read-Only share (RO)',
  toastSwitchedRo: '✓ Switched tab to Read-Only (RO)',
  toastSwitchedRw: '✓ Switched tab to Read-Write (RW)',
  toastStoppedShare: 'Stopped sharing this tab',
  toastCapturingFull: 'Capturing full-page screenshot…',
  toastSavedDownloads: (f) => `✓ Saved to Downloads\\${f}`,
  toastSaveFailed: (e) => `Failed saving screenshot: ${e}`,
  toastShotFailed: (e) => `Screenshot failed: ${e}`,
  toastHostTimeout: 'Local native host did not respond.',
};

const ZH_TW: ExtensionMessages = {
  globalReadOnlyBadge: '全域唯讀',
  allTabsBadge: '全分頁開放',
  connectedHost: (v, tag) => `已連線宿主 v${v} · ${tag}`,
  hostDisconnected: '宿主未連線',
  connecting: '正在連線…',
  dark: '深色',
  light: '淺色',
  settings: '設定',
  back: '返回',
  workerOutdated: (oldVer, newVer) => `背景服務仍為舊版 v${oldVer}，重新載入後啟用完整 v${newVer} 功能。`,
  reloadNow: '一鍵重載',
  menuNotReady: '右鍵選單未就緒：請在 edge://extensions 點擊 Browser Bridge 的重新整理圖示（↻）授予選單權限。',
  retryMenus: '重試註冊',
  hostMissing: '未偵測到本機宿主註冊，請執行儲存庫內的 scripts\\install.ps1。',
  connectionError: (err) => `連線異常：${err}`,
  noBackgroundResponse: '擴充功能背景未回應。',
  untitledTab: '未命名分頁',
  internalPageHint: '瀏覽器內部頁面無法分享給 Agent，請切換至一般網頁。',
  sharedRo: (id) => `唯讀分享 (RO) · Tab #${id}`,
  sharedRw: (id) => `讀寫分享 (RW) · Tab #${id}`,
  switchToRw: '切換為讀寫',
  switchToRo: '切換為唯讀',
  globalLockActive: '全域唯讀鎖已開啟',
  promptBoxTitle: '點擊複製傳給 Agent 的極簡提示詞',
  promptBoxLabel: '傳給 AGENT 的提示詞（含權限與本機指南）',
  copiedShort: '✓ 已複製',
  clickToCopy: '點擊複製',
  copiedPromptBtn: '✓ 已複製提示詞',
  copyPromptBtn: '複製 Agent 提示詞',
  stopSharing: '停止分享',
  shareRoAndCopy: '唯讀分享 + 複製提示詞',
  shareRw: '讀寫分享',
  unsharedHint: '唯讀僅允許檢視結構、讀取文字與背景截圖；讀寫允許點擊、填表與導覽（點擊後均自動複製提示詞）。',
  noActiveTab: '未偵測到目前作用中分頁。',
  otherSharedTabs: '其他已分享頁面',
  jumpToTitle: (url) => `切換至：${url}`,
  promptShort: '提示詞',
  removeShare: '移除',
  accessInUse: (owner) => `${owner} 使用中`,
  accessShared: '已分享',
  accessAgentOpened: 'Agent 開啟',
  languageLabel: '介面語言 (Language)',
  langAuto: '跟隨瀏覽器 (Auto)',
  globalReadOnlyLabel: '全域唯讀鎖（禁止任何操作與點擊）',
  globalReadOnlyDesc: '開啟後強制所有已分享頁面進入唯讀狀態，Agent 只能檢視內容與截圖，無法點擊、輸入或跳轉。',
  trustedInputLabel: '可信鍵鼠與背景長截圖 (CDP)',
  trustedInputDesc: '模擬真實點擊並支援背景無感整頁截圖；啟用時瀏覽器會顯示除錯橫幅。',
  allowEvaluateLabel: '允許執行頁面指令碼 (evaluate)',
  allowEvaluateDesc: '允許 Agent 在頁面內執行 JS（宿主亦須帶 --allow-evaluate 啟動）。',
  accessAllTabsLabel: '開放全部分頁存取',
  accessAllTabsDesc: '開啟後無需逐頁分享，Agent 可存取目前瀏覽器所有分頁（請謹慎開啟）。',
  profileLabel: '瀏覽器執行個體備註 (Label)',
  profilePlaceholder: '例如 Work / Trading',
  activeSessions: (n) => `活躍工作階段 ${n}`,
  noSessions: '暫無工作階段',
  copyGuideTitle: (p) => `點擊複製本機指南路徑：${p}`,
  copiedGuidePath: '✓ 已複製 AGENT.md 路徑',
  copyGuidePath: '複製 AGENT.md 路徑',
  reconnect: '重新連線',
  menuShareRoCopy: '唯讀分享並複製提示詞 (RO)',
  menuShareRwCopy: '讀寫分享並複製提示詞 (RW)',
  menuSelectionCopy: '引用選取文字複製提示詞 (RO)',
  menuLinkCopy: '引用此連結複製提示詞 (RO)',
  menuEnableRoOnly: '僅開啟唯讀分享 (RO)',
  menuSwitchToRw: '切換為讀寫分享 (RW)',
  menuSwitchToRo: '切換為唯讀分享 (RO)',
  menuStopShare: '停止分享此頁面',
  menuShotViewport: '擷取目前視窗 (儲存至 Downloads)',
  menuShotFullPage: '擷取整頁長圖 (儲存至 Downloads)',
  toastSharedRoCopied: '✓ 已開啟唯讀分享並複製 Agent 提示詞',
  toastSharedRwCopied: '✓ 已開啟讀寫分享並複製 Agent 提示詞',
  toastEnabledRo: '✓ 已開啟唯讀分享 (RO)',
  toastSwitchedRo: '✓ 已切換為唯讀分享 (RO)',
  toastSwitchedRw: '✓ 已切換為讀寫分享 (RW)',
  toastStoppedShare: '已停止分享此頁面',
  toastCapturingFull: '正在擷取整頁長圖…',
  toastSavedDownloads: (f) => `✓ 已儲存至 Downloads\\${f}`,
  toastSaveFailed: (e) => `截圖儲存失敗：${e}`,
  toastShotFailed: (e) => `截圖失敗：${e}`,
  toastHostTimeout: '本機宿主未回應，請檢查連線。',
};

const JA: ExtensionMessages = {
  globalReadOnlyBadge: '全体読取専用',
  allTabsBadge: '全タブ許可',
  connectedHost: (v, tag) => `ホスト接続済 v${v} · ${tag}`,
  hostDisconnected: 'ホスト未接続',
  connecting: '接続中…',
  dark: 'ダーク',
  light: 'ライト',
  settings: '設定',
  back: '戻る',
  workerOutdated: (oldVer, newVer) => `バックグラウンドが旧版 v${oldVer} です。再読込して v${newVer} を有効化してください。`,
  reloadNow: '再読込',
  menuNotReady: '右クリックメニュー未有効：edge://extensions で Browser Bridge の更新（↻）を1回クリックしてください。',
  retryMenus: '再試行',
  hostMissing: 'ネイティブホストが未登録です。リポジトリの scripts\\install.ps1 を実行してください。',
  connectionError: (err) => `接続エラー：${err}`,
  noBackgroundResponse: '拡張機能のバックグラウンドが応答しません。',
  untitledTab: '無題のタブ',
  internalPageHint: 'ブラウザ内部ページは Agent に共有できません。通常の Web ページに切り替えてください。',
  sharedRo: (id) => `読取専用 (RO) · Tab #${id}`,
  sharedRw: (id) => `読み書き (RW) · Tab #${id}`,
  switchToRw: 'RW に切替',
  switchToRo: 'RO に切替',
  globalLockActive: '全体読取専用ロック中',
  promptBoxTitle: 'クリックして Agent 用プロンプトをコピー',
  promptBoxLabel: 'AGENT 用プロンプト（権限・ローカルガイド付）',
  copiedShort: '✓ コピー済',
  clickToCopy: 'クリックでコピー',
  copiedPromptBtn: '✓ コピーしました',
  copyPromptBtn: 'Agent プロンプトをコピー',
  stopSharing: '共有停止',
  shareRoAndCopy: '読取専用で共有 + コピー',
  shareRw: '読み書き共有',
  unsharedHint: '読取専用は構造確認・テキスト取得・背景スクショのみ許可。読み書きはクリック・入力・遷移も許可します。',
  noActiveTab: 'アクティブなタブが見つかりません。',
  otherSharedTabs: 'その他の共有タブ',
  jumpToTitle: (url) => `切り替え：${url}`,
  promptShort: 'プロンプト',
  removeShare: '解除',
  accessInUse: (owner) => `${owner} が使用中`,
  accessShared: '共有中',
  accessAgentOpened: 'Agent が作成',
  languageLabel: '表示言語 (Language)',
  langAuto: 'ブラウザに従う (Auto)',
  globalReadOnlyLabel: '全体読取専用ロック（全操作をブロック）',
  globalReadOnlyDesc: '有効にすると全共有タブが読取専用になり、クリック・入力・遷移を禁止します。',
  trustedInputLabel: '信頼済み入力と背景フルページ撮影 (CDP)',
  trustedInputDesc: 'ネイティブ入力と背景フルページスクショを有効化します（デバッグバナーが表示されます）。',
  allowEvaluateLabel: 'ページスクリプト実行を許可 (evaluate)',
  allowEvaluateDesc: 'ページ内 JS 実行を許可します（ホスト側にも --allow-evaluate が必要です）。',
  accessAllTabsLabel: 'すべてのタブへのアクセスを許可',
  accessAllTabsDesc: '個別共有なしで全タブへのアクセスを許可します（注意して有効化してください）。',
  profileLabel: 'ブラウザ識別ラベル (Label)',
  profilePlaceholder: '例: Work / Trading',
  activeSessions: (n) => `接続セッション ${n}`,
  noSessions: '待機中',
  copyGuideTitle: (p) => `ローカルガイドのパスをコピー：${p}`,
  copiedGuidePath: '✓ AGENT.md パスをコピー済',
  copyGuidePath: 'AGENT.md パスをコピー',
  reconnect: '再接続',
  menuShareRoCopy: '読取専用で共有してプロンプトをコピー (RO)',
  menuShareRwCopy: '読み書き共有してプロンプトをコピー (RW)',
  menuSelectionCopy: '選択テキストを引用してコピー (RO)',
  menuLinkCopy: 'リンクを引用してコピー (RO)',
  menuEnableRoOnly: '読取専用共有のみ有効化 (RO)',
  menuSwitchToRw: '読み書き共有に切替 (RW)',
  menuSwitchToRo: '読取専用共有に切替 (RO)',
  menuStopShare: 'このタブの共有を停止',
  menuShotViewport: '表示領域をスクショ (Downloads に保存)',
  menuShotFullPage: 'ページ全体をスクショ (Downloads に保存)',
  toastSharedRoCopied: '✓ 読取専用で共有しプロンプトをコピーしました',
  toastSharedRwCopied: '✓ 読み書き共有しプロンプトをコピーしました',
  toastEnabledRo: '✓ 読取専用共有を有効化しました (RO)',
  toastSwitchedRo: '✓ 読取専用共有に切り替えました (RO)',
  toastSwitchedRw: '✓ 読み書き共有に切り替えました (RW)',
  toastStoppedShare: 'このタブの共有を停止しました',
  toastCapturingFull: 'ページ全体をキャプチャ中…',
  toastSavedDownloads: (f) => `✓ Downloads\\${f} に保存しました`,
  toastSaveFailed: (e) => `保存に失敗しました：${e}`,
  toastShotFailed: (e) => `スクショに失敗しました：${e}`,
  toastHostTimeout: 'ローカルホストが応答しません。',
};

const CATALOGS: Record<ResolvedLocale, ExtensionMessages> = {
  'zh-CN': ZH_CN,
  en: EN,
  'zh-TW': ZH_TW,
  ja: JA,
};

export function extMessages(locale: ResolvedLocale): ExtensionMessages {
  return CATALOGS[locale] ?? EN;
}
