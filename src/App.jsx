import { useCallback, useEffect, useState } from 'react';
import SceneGenerationPage from './SceneGeneration.jsx';
import MapExpansion from './MapExpansion.jsx';
import UIProduction from './ui/UIProduction.jsx';

const ICON_PATHS = {
  map: <><path d="m3 7 6-3 6 3 6-3v13l-6 3-6-3-6 3z"/><path d="M9 4v13m6-10v13"/></>,
  upload: <><path d="M12 16V4m-4 4 4-4 4 4"/><path d="M20 16.5v2A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-2"/></>,
  spark: <><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/></>,
  save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></>,
  folder: <><path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 10h18"/></>,
  download: <><path d="M12 3v12m-4-4 4 4 4-4"/><path d="M5 17v3h14v-3"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.5.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.5-.9l-1.7.6-1.4-2.4L7.7 15a8 8 0 0 1 0-1.8l-1.4-1.1 1.4-2.4 1.7.6a8 8 0 0 1 1.5-.9l.3-1.8H14l.3 1.8a8 8 0 0 1 1.5.9l1.7-.6 1.4 2.4-1.4 1.1a8 8 0 0 1-.1 1.8Z"/></>,
  close: <><path d="m18 6-12 12M6 6l12 12"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  check: <><path d="m5 12 4 4L19 6"/></>,
  retry: <><path d="M20 7v5h-5"/><path d="M20 12a8 8 0 1 0 2 5"/></>,
  trash: <><path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/></>,
  fit: <><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"/></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></>,
  zoomIn: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5M10.5 7.5v6m-3-3h6"/></>,
  zip: <><path d="M4 3h12l4 4v14H4z"/><path d="M9 3v3h4V3m-2 3v2m0 2v2m0 2v2m0 2v2"/></>,
  arrowRight: <><path d="M5 12h14m-6-6 6 6-6 6"/></>,
};

function Icon({ name, size = 18, strokeWidth = 1.8, className = '' }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICON_PATHS[name]}</svg>;
}

function pageForPath(pathname) {
  if (pathname === '/map-expansion' || pathname === '/terrain') return 'terrain';
  if (pathname === '/scene-generation') return 'scene';
  if (pathname === '/ui-production') return 'ui';
  return 'home';
}

export default function App() {
  const [page, setPage] = useState(() => pageForPath(window.location.pathname));
  const [toast, setToast] = useState('');
  const [serverOffline, setServerOffline] = useState(false);
  const [config, setConfig] = useState({ configured: { openai: false, apiyi: false, gemini: false, qwen: false, kling: false }, models: { openai: 'gpt-image-2.5-sunburst', apiyi: 'gpt-image-2.6-sunburst', apiyiPrompt: 'gpt-5.4-mini', apiyiBaseUrl: 'https://api.apiyi.com/v1', apiyiImageQuality: 'high', gemini: 'gemini-nano-banana-2.1', openaiPrompt: 'gpt-5.4-mini', geminiPrompt: 'gemini-3.8-flash', qwen: 'qwen-image-3.0-pro', qwenPrompt: 'qwen3.8-max', qwenBaseUrl: 'https://dashscope.aliyuncs.com', kling: 'kling-v3', klingBaseUrl: 'https://api-beijing.klingai.com' } });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState({ openaiKey: '', apiyiKey: '', geminiKey: '', qwenKey: '', klingKey: '', openaiModel: 'gpt-image-2.5-sunburst', apiyiBaseUrl: 'https://api.apiyi.com/v1', apiyiImageModel: 'gpt-image-2.6-sunburst', apiyiPromptModel: 'gpt-5.4-mini', apiyiImageQuality: 'high', geminiModel: 'gemini-nano-banana-2.1', openaiPromptModel: 'gpt-5.4-mini', geminiPromptModel: 'gemini-3.8-flash', qwenBaseUrl: 'https://dashscope.aliyuncs.com', qwenImageModel: 'qwen-image-3.0-pro', qwenPromptModel: 'qwen3.8-max', klingBaseUrl: 'https://api-beijing.klingai.com', klingModel: 'kling-v3', clearOpenaiKey: false, clearApiyiKey: false, clearGeminiKey: false, clearQwenKey: false, clearKlingKey: false });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const navigate = useCallback((path, { replace = false } = {}) => {
    const destination = path === '/terrain' ? '/map-expansion' : ['/map-expansion', '/scene-generation', '/ui-production'].includes(path) ? path : '/';
    if (window.location.pathname !== destination) {
      const method = replace ? 'replaceState' : 'pushState';
      window.history[method]({}, '', destination);
    }
    setPage(pageForPath(destination));
  }, []);

  useEffect(() => {
    const syncPage = () => {
      const pathname = window.location.pathname;
      if (pathname === '/terrain') navigate('/map-expansion', { replace: true });
      else if (pathname !== '/' && pathname !== '/map-expansion' && pathname !== '/scene-generation' && pathname !== '/ui-production') navigate('/', { replace: true });
      else setPage(pageForPath(pathname));
    };
    window.addEventListener('popstate', syncPage);
    syncPage();
    return () => window.removeEventListener('popstate', syncPage);
  }, [navigate]);

  const notify = useCallback((message) => {
    setToast(message);
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => setToast(''), 3400);
  }, []);

  useEffect(() => {
    document.title = page === 'home' ? '生产工厂 · 游戏资产生成' : page === 'scene' ? '场景生成 · 游戏场景制作' : page === 'ui' ? 'UI 制作 · 游戏界面拆分与 Unity 导出' : '地图扩张 · 游戏地图制作';
  }, [page]);

  useEffect(() => {
    fetch('/api/config').then(async (response) => {
      if (!response.ok) throw new Error('本机服务未启动');
      const value = await response.json();
      setConfig(value);
      setSettingsDraft((draft) => ({ ...draft, openaiModel: value.models.openai, apiyiBaseUrl: value.models.apiyiBaseUrl || 'https://api.apiyi.com/v1', apiyiImageModel: value.models.apiyi || 'gpt-image-2.6-sunburst', apiyiPromptModel: value.models.apiyiPrompt || 'gpt-5.4-mini', apiyiImageQuality: value.models.apiyiImageQuality || 'high', geminiModel: value.models.gemini, openaiPromptModel: value.models.openaiPrompt || 'gpt-5.4-mini', geminiPromptModel: value.models.geminiPrompt || 'gemini-3.8-flash', qwenBaseUrl: value.models.qwenBaseUrl || 'https://dashscope.aliyuncs.com', qwenImageModel: value.models.qwen || 'qwen-image-3.0-pro', qwenPromptModel: value.models.qwenPrompt || 'qwen3.8-max', klingBaseUrl: value.models.klingBaseUrl || 'https://api-beijing.klingai.com', klingModel: value.models.kling || 'kling-v3' }));
      setServerOffline(false);
    }).catch(() => setServerOffline(true));
  }, []);

  const openSettings = useCallback(() => {
    setSettingsDraft((draft) => ({ ...draft, openaiKey: '', apiyiKey: '', geminiKey: '', qwenKey: '', klingKey: '', openaiModel: config.models.openai, apiyiBaseUrl: config.models.apiyiBaseUrl || 'https://api.apiyi.com/v1', apiyiImageModel: config.models.apiyi || 'gpt-image-2.6-sunburst', apiyiPromptModel: config.models.apiyiPrompt || 'gpt-5.4-mini', apiyiImageQuality: config.models.apiyiImageQuality || 'high', geminiModel: config.models.gemini, openaiPromptModel: config.models.openaiPrompt || 'gpt-5.4-mini', geminiPromptModel: config.models.geminiPrompt || 'gemini-3.8-flash', qwenBaseUrl: config.models.qwenBaseUrl || 'https://dashscope.aliyuncs.com', qwenImageModel: config.models.qwen || 'qwen-image-3.0-pro', qwenPromptModel: config.models.qwenPrompt || 'qwen3.8-max', klingBaseUrl: config.models.klingBaseUrl || 'https://api-beijing.klingai.com', klingModel: config.models.kling || 'kling-v3', clearOpenaiKey: false, clearApiyiKey: false, clearGeminiKey: false, clearQwenKey: false, clearKlingKey: false }));
    setSettingsOpen(true);
  }, [config.models]);

  const saveSettings = useCallback(async () => {
    setSettingsSaving(true);
    try {
      const response = await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settingsDraft) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '设置保存失败。');
      setConfig(result); setSettingsOpen(false); setServerOffline(false); notify('模型设置已保存在本机。');
    } catch (error) { notify(`保存服务设置失败：${error.message}`); }
    finally { setSettingsSaving(false); }
  }, [notify, settingsDraft]);


  return <div className={`app-shell ${page === 'home' ? 'home-shell' : page === 'ui' ? 'ui-shell' : 'terrain-shell'} ${page === 'scene' ? 'scene-shell region-shell' : ''}`}>
    <header className={`topbar ${page === 'home' ? 'home-topbar' : 'terrain-topbar'} ${page === 'scene' ? 'scene-topbar' : ''}`}>
      <button className="brand-lockup brand-home-link" onClick={() => navigate('/')} aria-label="返回生产工厂首页">
        <div className="brand-mark"><Icon name="map" size={21}/></div><div><div className="brand-name">生产工厂</div><div className="brand-caption">GAME ASSET FACTORY</div></div>
      </button>
      {page !== 'home' && <><div className="topbar-center"><span className="local-pill"><span className="status-dot"/>本地工作区</span><span className="topbar-separator"/>{page === 'scene' ? '场景生成工作台' : page === 'ui' ? 'UI 制作工作台' : '地图扩张工作台'}</div><div className="topbar-actions"><button className="icon-button settings-trigger" onClick={openSettings} aria-label="服务设置" title="服务设置"><Icon name="settings"/></button></div></>}
    </header>
    {page === 'home' ? <main className="home-page">
        <div className="home-content">
          <section className="home-hero">
            <div className="home-hero-copy">
              <div className="home-eyebrow"><span className="status-dot"/>游戏资产生成空间 <i/> GAME ASSET FACTORY</div>
              <h1>为游戏创意，<br/><em>生产游戏资产。</em></h1>
              <p>面向游戏开发的创作工厂，从地图扩张开始，逐步覆盖角色、场景与道具。</p>
              <div className="home-hero-note"><Icon name="lock" size={13}/>地图项目保存在此浏览器的本机数据库</div>
            </div>
            <div className="home-hero-art" aria-hidden="true">
              <div className="hero-orbit orbit-one"/><div className="hero-orbit orbit-two"/>
              <div className="hero-map-surface">
                {Array.from({ length: 9 }, (_, index) => <span key={index} className={`hero-map-tile hero-map-tile-${index + 1}`}/>)}
                <span className="hero-map-river"/><span className="hero-map-road"/><span className="hero-map-marker"><i/></span>
              </div>
              <div className="hero-art-label"><span className="live-dot"/> MAP EXPANSION <b>AI</b></div>
              <div className="hero-art-coordinate">47° 18′ N&nbsp; 08° 32′ E</div>
            </div>
            <span className="hero-index">01 / CREATE</span>
          </section>

          <section className="home-tools-section" id="asset-tools">
              <div className="home-section-heading">
                <div><span className="panel-eyebrow">GAME ASSET TOOLS</span><h2>生产功能</h2></div>
                <span className="tool-count">03 / 05 已开放</span>
              </div>
              <div className="asset-tool-grid">
                {[
                  { name: '地图扩张', description: '延展地图边界，生成并拼接相邻区域。', status: '已开放', icon: 'map', active: true, path: '/map-expansion' },
                  { name: '角色生成', description: '为游戏角色制作概念图与视觉设定。', status: '筹备中', icon: 'spark' },
                  { name: '场景生成', description: '圈选格子区域，填写场景要求并生成对应内容。', status: '已开放', icon: 'image', active: true, path: '/scene-generation' },
                  { name: 'UI 制作', description: '生成或导入游戏 UI，校对拆分元素并导出 Unity UGUI。', status: '已开放', icon: 'image', active: true, path: '/ui-production' },
                  { name: '道具生成', description: '设计游戏道具、装备与物件素材。', status: '筹备中', icon: 'plus' },
                ].map((tool, index) => <button key={tool.name} className={`asset-tool-tag ${tool.active ? 'available' : 'coming-soon'}`} disabled={!tool.active} onClick={() => tool.active && navigate(tool.path)}>
                  <span className="asset-tool-tag-top"><span className="asset-tool-index">0{index + 1}</span><span className={`asset-tool-status ${tool.active ? 'status-open' : ''}`}>{tool.status}</span></span>
                  <span className="asset-tool-title"><Icon name={tool.icon} size={18}/><strong>{tool.name}</strong></span>
                  <span className="asset-tool-description">{tool.description}</span>
                  {tool.active && <span className="asset-tool-enter">进入功能<Icon name="arrowRight" size={14}/></span>}
                </button>)}
              </div>
              <div className="home-local-note"><Icon name="lock" size={14}/><span>项目保存在当前浏览器。生成或分析 UI 时，相关描述与所选图片会发送给已配置的 AI 服务。</span></div>
          </section>
          <footer className="home-footer"><span>生产工厂 <i/> GAME ASSET FACTORY</span><span>为游戏资产创作而设计</span></footer>
        </div>
      </main> : page === 'scene' ? <SceneGenerationPage config={config} serverOffline={serverOffline} onOpenSettings={openSettings}/> : page === 'ui' ? <UIProduction config={config} serverOffline={serverOffline} onOpenSettings={openSettings} onNotify={notify}/> : <MapExpansion config={config} serverOffline={serverOffline} onOpenSettings={openSettings} onNotify={notify}/>}
      {settingsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
        <section className="modal-card settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div className="modal-header"><div className="modal-icon"><Icon name="settings"/></div><div><span className="panel-eyebrow">LOCAL MODEL SETUP</span><h2 id="settings-title">服务设置</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="关闭"><Icon name="close"/></button></div>
          <p className="modal-intro">API key 保存在此电脑的本机配置文件中，网页不会读取或回显已保存的密钥。</p>
          <div className="settings-provider-block"><div className="settings-provider-title"><span className="provider-logo google-logo">✦</span><div><strong>Google Nano Banana</strong><small>{config.configured.gemini ? '密钥已配置' : '尚未配置'}</small></div><span className={`provider-state ${config.configured.gemini ? 'active' : ''}`}>{config.configured.gemini ? '已配置' : '未配置'}</span></div>
            <label className="field-label">图像生成模型 ID</label><input className="settings-input" value={settingsDraft.geminiModel} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, geminiModel: event.target.value }))}/>
            <label className="field-label">提示词模型 ID</label><input className="settings-input" value={settingsDraft.geminiPromptModel} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, geminiPromptModel: event.target.value }))}/>
            <label className="field-label">API key</label><input className="settings-input" type="password" autoComplete="new-password" placeholder={config.configured.gemini ? '已保存 · 留空保持不变' : '粘贴 Google AI Studio API key'} value={settingsDraft.geminiKey} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, geminiKey: event.target.value, clearGeminiKey: false }))}/>
            {config.configured.gemini && <button className="clear-key" onClick={() => setSettingsDraft((draft) => ({ ...draft, clearGeminiKey: !draft.clearGeminiKey, geminiKey: '' }))}>{settingsDraft.clearGeminiKey ? '将清除此密钥' : '清除此密钥'}</button>}
          </div>
          <div className="settings-provider-block"><div className="settings-provider-title"><span className="provider-logo openai-logo">◉</span><div><strong>OpenAI GPT Image</strong><small>{config.configured.openai ? '密钥已配置' : '尚未配置'}</small></div><span className={`provider-state ${config.configured.openai ? 'active' : ''}`}>{config.configured.openai ? '已配置' : '未配置'}</span></div>
            <label className="field-label">图像生成模型 ID</label><input className="settings-input" value={settingsDraft.openaiModel} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, openaiModel: event.target.value }))}/>
            <label className="field-label">提示词模型 ID</label><input className="settings-input" value={settingsDraft.openaiPromptModel} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, openaiPromptModel: event.target.value }))}/>
            <label className="field-label">API key</label><input className="settings-input" type="password" autoComplete="new-password" placeholder={config.configured.openai ? '已保存 · 留空保持不变' : '粘贴 OpenAI API key'} value={settingsDraft.openaiKey} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, openaiKey: event.target.value, clearOpenaiKey: false }))}/>
            {config.configured.openai && <button className="clear-key" onClick={() => setSettingsDraft((draft) => ({ ...draft, clearOpenaiKey: !draft.clearOpenaiKey, openaiKey: '' }))}>{settingsDraft.clearOpenaiKey ? '将清除此密钥' : '清除此密钥'}</button>}
          </div>
          <div className="settings-provider-block"><div className="settings-provider-title"><span className="provider-logo openai-logo">易</span><div><strong>API易 · GPT Image</strong><small>{config.configured.apiyi ? '密钥已配置' : '尚未配置'}</small></div><span className={`provider-state ${config.configured.apiyi ? 'active' : ''}`}>{config.configured.apiyi ? '已配置' : '未配置'}</span></div>
            <label className="field-label">Base URL</label><input className="settings-input" placeholder="https://api.apiyi.com/v1" value={settingsDraft.apiyiBaseUrl} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, apiyiBaseUrl: event.target.value }))}/>
            <small className="settings-help">使用 API易 的 OpenAI 兼容接口；未填写 /v1 时会自动补齐。</small>
            <label className="field-label">图像生成模型 ID</label><input className="settings-input" value={settingsDraft.apiyiImageModel} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, apiyiImageModel: event.target.value }))}/>
            <label className="field-label">提示词模型 ID（支持图像输入）</label><input className="settings-input" value={settingsDraft.apiyiPromptModel} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, apiyiPromptModel: event.target.value }))}/>
            <label className="field-label">图像画质</label><select className="settings-input" value={settingsDraft.apiyiImageQuality} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, apiyiImageQuality: event.target.value }))}>{['low', 'medium', 'high', 'xhigh', 'max'].map((quality) => <option key={quality} value={quality}>{quality}</option>)}</select>
            <label className="field-label">API key</label><input className="settings-input" type="password" autoComplete="new-password" placeholder={config.configured.apiyi ? '已保存 · 留空保持不变' : '粘贴 API易 API key'} value={settingsDraft.apiyiKey} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, apiyiKey: event.target.value, clearApiyiKey: false }))}/>
            {config.configured.apiyi && <button className="clear-key" onClick={() => setSettingsDraft((draft) => ({ ...draft, clearApiyiKey: !draft.clearApiyiKey, apiyiKey: '' }))}>{settingsDraft.clearApiyiKey ? '将清除此密钥' : '清除此密钥'}</button>}
          </div>
          <div className="settings-provider-block"><div className="settings-provider-title"><span className="provider-logo qwen-logo">通</span><div><strong>阿里云百炼 · 千问</strong><small>{config.configured.qwen ? '密钥已配置' : '尚未配置'}</small></div><span className={`provider-state ${config.configured.qwen ? 'active' : ''}`}>{config.configured.qwen ? '已配置' : '未配置'}</span></div>
            <label className="field-label">百炼 API 端点（区域 / 工作空间域名）</label><input className="settings-input" placeholder="https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com" value={settingsDraft.qwenBaseUrl} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, qwenBaseUrl: event.target.value }))}/>
            <small className="settings-help">可填控制台工作空间域名；北京默认地址为 https://dashscope.aliyuncs.com。</small>
            <label className="field-label">图像生成模型 ID</label><input className="settings-input" value={settingsDraft.qwenImageModel} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, qwenImageModel: event.target.value }))}/>
            <label className="field-label">提示词模型 ID（支持图像输入）</label><input className="settings-input" value={settingsDraft.qwenPromptModel} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, qwenPromptModel: event.target.value }))}/>
            <label className="field-label">百炼 API key</label><input className="settings-input" type="password" autoComplete="new-password" placeholder={config.configured.qwen ? '已保存 · 留空保持不变' : '粘贴百炼 API key'} value={settingsDraft.qwenKey} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, qwenKey: event.target.value, clearQwenKey: false }))}/>
            {config.configured.qwen && <button className="clear-key" onClick={() => setSettingsDraft((draft) => ({ ...draft, clearQwenKey: !draft.clearQwenKey, qwenKey: '' }))}>{settingsDraft.clearQwenKey ? '将清除此密钥' : '清除此密钥'}</button>}
          </div>
          <div className="settings-provider-block"><div className="settings-provider-title"><span className="provider-logo kling-logo">可</span><div><strong>可灵 AI</strong><small>{config.configured.kling ? '密钥已配置' : '尚未配置'}</small></div><span className={`provider-state ${config.configured.kling ? 'active' : ''}`}>{config.configured.kling ? '已配置' : '未配置'}</span></div>
            <label className="field-label">可灵 API 端点</label><input className="settings-input" placeholder="https://api-beijing.klingai.com" value={settingsDraft.klingBaseUrl} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, klingBaseUrl: event.target.value }))}/>
            <small className="settings-help">中国区服务使用北京域名；API Key 按官方格式通过 Bearer 鉴权。</small>
            <label className="field-label">图像生成模型 ID</label><input className="settings-input" value={settingsDraft.klingModel} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, klingModel: event.target.value }))}/>
            <label className="field-label">API key</label><input className="settings-input" type="password" autoComplete="new-password" placeholder={config.configured.kling ? '已保存 · 留空保持不变' : '粘贴 Kling 开放平台 API key'} value={settingsDraft.klingKey} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, klingKey: event.target.value, clearKlingKey: false }))}/>
            {config.configured.kling && <button className="clear-key" onClick={() => setSettingsDraft((draft) => ({ ...draft, clearKlingKey: !draft.clearKlingKey, klingKey: '' }))}>{settingsDraft.clearKlingKey ? '将清除此密钥' : '清除此密钥'}</button>}
          </div>
          <div className="settings-local-note"><Icon name="lock" size={14}/><span>密钥仅由本机 Node 服务持有。此处“已配置”表示密钥已保存，不代表 API 连通性已测试；实际调用时才会验证服务。千问支持提示词和图像生成，可灵支持图像生成，调用按服务商规则计费。</span></div>
          <div className="modal-footer"><button className="button button-quiet" onClick={() => setSettingsOpen(false)}>取消</button><button className="button button-dark" onClick={saveSettings} disabled={settingsSaving}>{settingsSaving ? '保存中…' : '保存设置'}</button></div>
        </section>
      </div>}


    {toast && <div className="toast-message"><span className="toast-mark"><Icon name="check" size={14}/></span>{toast}</div>}
  </div>;
}
