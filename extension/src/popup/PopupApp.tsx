import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Switch } from '@astryxdesign/core/Switch';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { api } from '../shared/api.ts';
import {
  extMessages,
  isLocaleSetting,
  LOCALE_OPTIONS,
  resolveLocale,
  type LocaleSetting,
} from '../shared/i18n.ts';
import { buildAgentPrompt, defaultGuidePath, hostOfUrl, isShareableUrl } from './prompt.ts';

declare const __EXT_VERSION__: string;
const POPUP_VERSION = typeof __EXT_VERSION__ === 'string' ? __EXT_VERSION__ : '0.10.1';

export interface PopupState {
  status: string;
  error: string;
  hostVersion: string;
  pipeName: string;
  agentGuide?: string;
  browser?: string;
  instanceId?: string;
  extensionVersion: string;
  contextMenuReady?: boolean;
  contextMenuError?: string;
  settings: {
    accessAllTabs: boolean;
    readOnlyMode?: boolean;
    trustedInput: boolean;
    allowEvaluate: boolean;
    groupAgentTabs?: boolean;
    idleCloseMinutes?: number;
    label: string;
    locale?: LocaleSetting;
  };
  trustedInputSupported: boolean;
  sessions: Array<{ id: string; name: string }>;
  handoffs?: Array<{ id: string; tabId: number; origin: string; message: string }>;
  demonstrations?: Array<{ id: string; tabId: number; origin: string; instruction: string; stepCount: number }>;
  currentTab: {
    id: number;
    title: string;
    url: string;
    shared: boolean;
    mode?: 'read' | 'write';
    access: string;
    scriptable?: boolean;
  } | null;
  tabs: Array<{ id: number; title: string; url: string; access: string; mode?: 'read' | 'write' }>;
}

async function sendPopup(message: Record<string, unknown>, fallbackErr = 'No response.'): Promise<PopupState> {
  const response = (await api.runtime.sendMessage(message)) as { ok: boolean; result?: PopupState; error?: string };
  if (!response?.ok) throw new Error(response?.error ?? fallbackErr);
  return response.result!;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const el = document.createElement('textarea');
  el.value = text;
  el.style.position = 'fixed';
  el.style.opacity = '0';
  document.body.appendChild(el);
  el.select();
  document.execCommand('copy');
  el.remove();
}

function monogramOf(url: string): string {
  const host = hostOfUrl(url).replace(/^www\./i, '');
  return host.slice(0, 1).toUpperCase() || '•';
}

export function PopupApp() {
  const [state, setState] = useState<PopupState | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<'main' | 'settings'>('main');
  const [mode, setMode] = useState<'light' | 'dark'>(() => {
    let initial: 'light' | 'dark' = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    try {
      const saved = window.localStorage.getItem('bb-theme-mode');
      if (saved === 'light' || saved === 'dark') initial = saved;
    } catch {
      // ignore storage failure
    }
    document.documentElement.setAttribute('data-theme', initial);
    return initial;
  });

  const toggleMode = useCallback(() => {
    setMode((prev) => {
      const next = prev === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      try {
        window.localStorage.setItem('bb-theme-mode', next);
      } catch {
        // ignore
      }
      return next;
    });
  }, []);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [localeSetting, setLocaleSetting] = useState<LocaleSetting>(() => {
    try {
      const saved = window.localStorage.getItem('bb-locale');
      if (isLocaleSetting(saved)) return saved;
    } catch {
      // ignore storage failure
    }
    return 'auto';
  });
  const [labelDraft, setLabelDraft] = useState('');
  const editingLabel = useRef(false);
  const hasLocalLocale = useRef<boolean>((() => {
    try {
      return isLocaleSetting(window.localStorage.getItem('bb-locale'));
    } catch {
      return false;
    }
  })());
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flashCopied = useCallback((key: string) => {
    setCopiedKey(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedKey(null), 1800);
  }, []);

  const applyState = useCallback((next: PopupState) => {
    setState(next);
    setError('');
    if (!editingLabel.current) {
      setLabelDraft(next.settings.label);
    }
    if (!hasLocalLocale.current && isLocaleSetting(next.settings.locale)) {
      setLocaleSetting(next.settings.locale);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      applyState(await sendPopup({ type: 'popup:state' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [applyState]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      void sendPopup({ type: 'popup:state' }).then(applyState, () => undefined);
    }, 2500);
    return () => {
      window.clearInterval(id);
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, [applyState, refresh]);

  const promptForTab = (
    tabId: number,
    url: string,
    tabMode?: 'read' | 'write',
    title?: string,
    s: PopupState | null = state,
  ) => {
    const pipeParts = (s?.pipeName ?? '').split('.');
    const browserFromPipe = pipeParts.length >= 4 ? pipeParts[2] : '';
    const instanceFromPipe = pipeParts.length >= 4 ? pipeParts[3] : '';
    const effective = s?.settings.readOnlyMode ? 'read' : (tabMode ?? 'read');
    return buildAgentPrompt({
      tabId,
      url,
      title,
      mode: effective,
      browser: s?.browser || browserFromPipe || 'edge',
      instanceId: s?.instanceId || instanceFromPipe || '',
      agentGuide: s?.agentGuide || '',
    });
  };

  const handleShare = async (
    tabId: number,
    share: boolean,
    shareMode: 'read' | 'write' = 'read',
    copyPromptAfter = false,
  ) => {
    try {
      const next = await sendPopup({ type: 'popup:share', tabId, share, mode: shareMode });
      applyState(next);
      if (share && copyPromptAfter) {
        const target = next.currentTab?.id === tabId ? next.currentTab : next.tabs.find((t) => t.id === tabId);
        if (target) {
          await copyText(promptForTab(tabId, target.url, target.mode ?? shareMode, target.title, next));
          flashCopied(`tab-${tabId}`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSetMode = async (tabId: number, nextMode: 'read' | 'write') => {
    try {
      applyState(await sendPopup({ type: 'popup:mode', tabId, mode: nextMode }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyPrompt = async (tabId: number, url: string, tabMode?: 'read' | 'write', title?: string) => {
    try {
      await copyText(promptForTab(tabId, url, tabMode, title));
      flashCopied(`tab-${tabId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const updatePatch = async (patch: Record<string, unknown>) => {
    try {
      applyState(await sendPopup({ type: 'popup:settings', patch }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const selectLocale = (nextLocale: LocaleSetting) => {
    hasLocalLocale.current = true;
    setLocaleSetting(nextLocale);
    try {
      window.localStorage.setItem('bb-locale', nextLocale);
    } catch {
      // ignore storage failure
    }
    void sendPopup({ type: 'popup:settings', patch: { locale: nextLocale } }).then(applyState, () => undefined);
  };

  const resolvedLocale = resolveLocale(localeSetting);
  const t = extMessages(resolvedLocale);
  const connected = state?.status === 'connected';
  const hostMissing =
    state?.status === 'error' && /not found|not registered|specified native messaging host/i.test(state.error);
  const workerOutdated = Boolean(state && state.extensionVersion && state.extensionVersion !== POPUP_VERSION);
  const currentTab = state?.currentTab ?? null;
  const currentShareable = currentTab !== null && currentTab.scriptable !== false && isShareableUrl(currentTab.url);
  const currentMode: 'read' | 'write' = state?.settings.readOnlyMode
    ? 'read'
    : (currentTab?.mode ?? 'read');
  const activePrompt = currentTab ? promptForTab(currentTab.id, currentTab.url, currentMode, currentTab.title) : '';
  const guidePath = state?.agentGuide || defaultGuidePath();
  const otherTabs = (state?.tabs ?? []).filter((tabItem) => tabItem.id !== currentTab?.id);
  const pendingHandoffs = state?.handoffs ?? [];
  const activeDemos = state?.demonstrations ?? [];
  const currentDemo = currentTab ? activeDemos.find((d) => d.tabId === currentTab.id) : undefined;
  const isZh = resolvedLocale.startsWith('zh');
  const isJa = resolvedLocale === 'ja';
  const uiExtra = {
    handoffWaitTitle: isZh ? '等待人工操作（WAIT）' : isJa ? 'ユーザー操作待ち (WAIT)' : 'Waiting for you (WAIT)',
    continueBtn: isZh ? '继续执行' : isJa ? '続行' : 'Continue',
    cancelBtn: isZh ? '取消' : isJa ? 'キャンセル' : 'Cancel',
    recordingStatus: (n: number) =>
      isZh ? `正在录制站点流程（已捕获 ${n} 步）` : isJa ? `手順を記録中 (${n} ステップ)` : `Recording site routine (${n} step${n === 1 ? '' : 's'})`,
    finishDemoBtn: isZh ? '完成并保存' : isJa ? '完了して保存' : 'Finish & Save',
    teachBtn: isZh ? '录制流程 (Teach)' : isJa ? '手順を記録' : 'Teach Routine',
    groupTabsLabel: isZh ? '后台折叠 Agent 标签组' : isJa ? 'Agent タブを背面グループに収納' : 'Collapse agent tabs in background group',
    groupTabsDesc: isZh ? 'Agent 新开标签默认静默放入折叠的 [Agent] 组，不抢焦点' : isJa ? '新規タブを背面の折りたたみグループで開きます' : 'Open agent tabs silently in a collapsed [Agent] group without stealing focus',
    idleCloseLabel: isZh ? '空闲标签自动回收' : isJa ? 'アイドルタブの自動クローズ' : 'Auto-close idle agent tabs',
    idleOff: isZh ? '关闭' : isJa ? 'オフ' : 'Never',
  };

  const localizeAccess = (raw: string) => {
    if (raw.startsWith('in use by ')) return t.accessInUse(raw.slice('in use by '.length));
    if (raw === 'shared') return t.accessShared;
    if (raw === 'opened by agent') return t.accessAgentOpened;
    return raw;
  };

  return (
    <Theme key={mode} theme={neutralTheme} mode={mode}>
      <div className="bb-shell">
        <header className="bb-header">
          <div className="bb-brand">
            <div className="bb-mark">B</div>
            <div className="bb-brand-copy">
              <div className="bb-brand-title">
                <span>Browser Bridge</span>
                {state?.settings.readOnlyMode && <Badge variant="teal" label={t.globalReadOnlyBadge} />}
                {state?.settings.accessAllTabs && <Badge variant="warning" label={t.allTabsBadge} />}
              </div>
              <div className="bb-status-line">
                <i className={`bb-dot ${connected ? 'connected' : state?.status === 'error' ? 'error' : ''}`} />
                <span>
                  {connected
                    ? t.connectedHost(state.hostVersion, state.settings.label || state.browser || 'Browser')
                    : state?.status === 'error'
                      ? t.hostDisconnected
                      : t.connecting}
                </span>
              </div>
            </div>
          </div>
          <div className="bb-header-actions">
            <Button
              label={mode === 'light' ? t.dark : t.light}
              variant="ghost"
              size="sm"
              onClick={toggleMode}
            />
            <Button
              label={view === 'main' ? t.settings : t.back}
              variant={view === 'settings' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setView((v) => (v === 'main' ? 'settings' : 'main'))}
            />
          </div>
        </header>

        {workerOutdated && (
          <div className="bb-upgrade-box" role="status">
            <span>{t.workerOutdated(state?.extensionVersion ?? '', POPUP_VERSION)}</span>
            <Button
              label={t.reloadNow}
              variant="secondary"
              size="sm"
              onClick={() => {
                api.runtime.reload();
                window.close();
              }}
            />
          </div>
        )}

        {!workerOutdated && state?.contextMenuReady === false && (
          <div className="bb-upgrade-box" role="status">
            <span>{t.menuNotReady}</span>
            <Button
              label={t.retryMenus}
              variant="secondary"
              size="sm"
              onClick={() => {
                void sendPopup({ type: 'popup:rebuildMenus' }).then(applyState, () => undefined);
              }}
            />
          </div>
        )}

        {(error || state?.status === 'error') && (
          <div className="bb-error-box" role="alert">
            {error || (hostMissing ? t.hostMissing : t.connectionError(state?.error ?? ''))}
          </div>
        )}

        {pendingHandoffs.map((ho) => (
          <div className="bb-upgrade-box" key={ho.id} role="status">
            <span>
              <strong>{uiExtra.handoffWaitTitle}</strong> · #{ho.tabId}: {ho.message}
            </span>
            <div className="bb-row-actions">
              <Button
                label={uiExtra.continueBtn}
                variant="primary"
                size="sm"
                onClick={() => {
                  void sendPopup({ type: 'popup:handoffResolve', tabId: ho.tabId, action: 'continue' }).then(applyState, () => undefined);
                }}
              />
              <Button
                label={uiExtra.cancelBtn}
                variant="ghost"
                size="sm"
                onClick={() => {
                  void sendPopup({ type: 'popup:handoffResolve', tabId: ho.tabId, action: 'cancel' }).then(applyState, () => undefined);
                }}
              />
            </div>
          </div>
        ))}

        {currentDemo && (
          <div className="bb-upgrade-box" role="status">
            <span>● {uiExtra.recordingStatus(currentDemo.stepCount)}</span>
            <div className="bb-row-actions">
              <Button
                label={uiExtra.finishDemoBtn}
                variant="primary"
                size="sm"
                onClick={() => {
                  void sendPopup({ type: 'popup:finishDemo', tabId: currentDemo.tabId, action: 'finish' }).then(applyState, () => undefined);
                }}
              />
              <Button
                label={uiExtra.cancelBtn}
                variant="ghost"
                size="sm"
                onClick={() => {
                  void sendPopup({ type: 'popup:finishDemo', tabId: currentDemo.tabId, action: 'cancel' }).then(applyState, () => undefined);
                }}
              />
            </div>
          </div>
        )}

        {view === 'main' ? (
          <>
            <Card padding={4}>
              <div className="bb-hero">
                {currentTab ? (
                  <>
                    <div className="bb-tab-head">
                      <div className="bb-site-monogram">{monogramOf(currentTab.url)}</div>
                      <div className="bb-tab-meta">
                        <div className="bb-tab-title">{currentTab.title || t.untitledTab}</div>
                        <div className="bb-tab-host">{hostOfUrl(currentTab.url)}</div>
                      </div>
                    </div>

                    {!currentShareable ? (
                      <div className="bb-hint">{t.internalPageHint}</div>
                    ) : currentTab.shared ? (
                      <>
                        <div className="bb-share-status">
                          <span className={`bb-share-pill ${currentMode === 'write' ? 'rw' : 'ro'}`}>
                            <i />
                            {currentMode === 'read' ? t.sharedRo(currentTab.id) : t.sharedRw(currentTab.id)}
                          </span>
                          {!state?.settings.readOnlyMode ? (
                            <button
                              type="button"
                              className="bb-link-btn"
                              onClick={() => {
                                void handleSetMode(currentTab.id, currentMode === 'read' ? 'write' : 'read');
                              }}
                            >
                              {currentMode === 'read' ? t.switchToRw : t.switchToRo}
                            </button>
                          ) : (
                            <span>{t.globalLockActive}</span>
                          )}
                        </div>
                        <div
                          className="bb-prompt-box"
                          role="button"
                          tabIndex={0}
                          title={t.promptBoxTitle}
                          onClick={() => {
                            void handleCopyPrompt(currentTab.id, currentTab.url, currentMode, currentTab.title);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              void handleCopyPrompt(currentTab.id, currentTab.url, currentMode, currentTab.title);
                            }
                          }}
                        >
                          <div className="bb-prompt-label">
                            <span>{t.promptBoxLabel}</span>
                            <span>{copiedKey === `tab-${currentTab.id}` ? t.copiedShort : t.clickToCopy}</span>
                          </div>
                          <div className="bb-prompt-code">{activePrompt}</div>
                        </div>
                        <div className="bb-cta-row">
                          <Button
                            label={copiedKey === `tab-${currentTab.id}` ? t.copiedPromptBtn : t.copyPromptBtn}
                            variant="primary"
                            onClick={() => {
                              void handleCopyPrompt(currentTab.id, currentTab.url, currentMode, currentTab.title);
                            }}
                          />
                          <Button
                            label={t.stopSharing}
                            variant="secondary"
                            onClick={() => { void handleShare(currentTab.id, false); }}
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="bb-cta-row">
                          <Button
                            label={t.shareRoAndCopy}
                            variant="primary"
                            onClick={() => { void handleShare(currentTab.id, true, 'read', true); }}
                          />
                          <Button
                            label={t.shareRw}
                            variant="secondary"
                            onClick={() => { void handleShare(currentTab.id, true, 'write', true); }}
                          />
                        </div>
                        <div className="bb-hint">{t.unsharedHint}</div>
                      </>
                    )}
                    {currentShareable && !currentDemo && !state?.settings.readOnlyMode && (
                      <div className="bb-cta-row" style={{ marginTop: 6 }}>
                        <Button
                          label={uiExtra.teachBtn}
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            void sendPopup({ type: 'popup:startDemo', tabId: currentTab.id }).then(() => window.close(), () => undefined);
                          }}
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <div className="bb-hint">{t.noActiveTab}</div>
                )}
              </div>
            </Card>

            {otherTabs.length > 0 && (
              <>
                <div className="bb-section-title">
                  <span>{t.otherSharedTabs}</span>
                  <span>{otherTabs.length}</span>
                </div>
                <div className="bb-tabs-list">
                  {otherTabs.map((item) => (
                    <div className="bb-tab-row" key={item.id}>
                      <div className="bb-site-monogram">{monogramOf(item.url)}</div>
                      <button
                        type="button"
                        className="bb-tab-jump"
                        title={t.jumpToTitle(item.url)}
                        onClick={() => {
                          void sendPopup({ type: 'popup:activate', tabId: item.id }).then(applyState, () => undefined);
                        }}
                      >
                        <strong>{item.title || item.url}</strong>
                        <small>
                          Tab #{item.id} [{item.mode === 'read' ? 'RO' : 'RW'}] · {hostOfUrl(item.url)} · {localizeAccess(item.access)}
                        </small>
                      </button>
                      <div className="bb-row-actions">
                        <Button
                          label={copiedKey === `tab-${item.id}` ? t.copiedShort : t.promptShort}
                          variant="ghost"
                          size="sm"
                          onClick={() => { void handleCopyPrompt(item.id, item.url, item.mode, item.title); }}
                        />
                        <Button
                          label={t.removeShare}
                          variant="ghost"
                          size="sm"
                          onClick={() => { void handleShare(item.id, false); }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        ) : (
          <Card padding={4}>
            <div className="bb-settings">
              <div className="bb-field-block" role="group" aria-label={t.languageLabel}>
                <span className="bb-field-label">{t.languageLabel}</span>
                <div className="bb-lang-grid">
                  {LOCALE_OPTIONS.map((opt) => (
                    <Button
                      key={opt.value}
                      label={opt.value === 'auto' ? t.langAuto : opt.label}
                      variant={localeSetting === opt.value ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => selectLocale(opt.value)}
                    />
                  ))}
                </div>
              </div>
              <Switch
                size="sm"
                label={t.globalReadOnlyLabel}
                description={t.globalReadOnlyDesc}
                value={state?.settings.readOnlyMode ?? false}
                onChange={(checked) => { void updatePatch({ readOnlyMode: checked }); }}
              />
              {state?.trustedInputSupported && (
                <Switch
                  size="sm"
                  label={uiExtra.groupTabsLabel}
                  description={uiExtra.groupTabsDesc}
                  value={state?.settings.groupAgentTabs ?? true}
                  onChange={(checked) => { void updatePatch({ groupAgentTabs: checked }); }}
                />
              )}
              <div className="bb-field-block" role="group" aria-label={uiExtra.idleCloseLabel}>
                <span className="bb-field-label">{uiExtra.idleCloseLabel}</span>
                <div className="bb-lang-grid">
                  {[10, 30, 60, 0].map((mins) => (
                    <Button
                      key={mins}
                      label={mins === 0 ? uiExtra.idleOff : `${mins}m`}
                      variant={(state?.settings.idleCloseMinutes ?? 10) === mins ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => { void updatePatch({ idleCloseMinutes: mins }); }}
                    />
                  ))}
                </div>
              </div>
              {state?.trustedInputSupported && (
                <Switch
                  size="sm"
                  label={t.trustedInputLabel}
                  description={t.trustedInputDesc}
                  value={state.settings.trustedInput}
                  onChange={(checked) => { void updatePatch({ trustedInput: checked }); }}
                />
              )}
              <Switch
                size="sm"
                label={t.allowEvaluateLabel}
                description={t.allowEvaluateDesc}
                value={state?.settings.allowEvaluate ?? false}
                onChange={(checked) => { void updatePatch({ allowEvaluate: checked }); }}
              />
              <Switch
                size="sm"
                label={t.accessAllTabsLabel}
                description={t.accessAllTabsDesc}
                value={state?.settings.accessAllTabs ?? false}
                onChange={(checked) => { void updatePatch({ accessAllTabs: checked }); }}
              />
              <TextInput
                label={t.profileLabel}
                placeholder={t.profilePlaceholder}
                value={labelDraft}
                onChange={(v) => {
                  editingLabel.current = true;
                  setLabelDraft(v);
                }}
                onBlur={() => {
                  editingLabel.current = false;
                  if (state && labelDraft !== state.settings.label) {
                    void updatePatch({ label: labelDraft.slice(0, 40) });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
              />
            </div>
          </Card>
        )}

        <footer className="bb-footer">
          <div className="bb-footer-left">
            <span>{state?.sessions.length ? t.activeSessions(state.sessions.length) : t.noSessions}</span>
            <span>·</span>
            <button
              type="button"
              className="bb-link-btn"
              title={t.copyGuideTitle(guidePath)}
              onClick={() => {
                void copyText(guidePath).then(() => flashCopied('guide'));
              }}
            >
              {copiedKey === 'guide' ? t.copiedGuidePath : t.copyGuidePath}
            </button>
          </div>
          <div className="bb-footer-right">
            <button
              type="button"
              className="bb-link-btn"
              onClick={() => {
                void sendPopup({ type: 'popup:reconnect' }).then(applyState, (err) =>
                  setError(err instanceof Error ? err.message : String(err)),
                );
              }}
            >
              {t.reconnect}
            </button>
            <span>v{state?.extensionVersion ?? POPUP_VERSION}</span>
          </div>
        </footer>
      </div>
    </Theme>
  );
}
