import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Drawer,
  Empty,
  Flex,
  Input,
  List,
  Modal,
  Popconfirm,
  Progress,
  Segmented,
  Switch,
  Tag,
  Typography,
  App as AntApp,
} from 'antd';
import {
  ArrowUpOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  HomeOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
  PlaySquareOutlined,
  ReloadOutlined,
  SettingOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { api, midTrunc, SITE_LABEL, fmtSpeed, fmtBytes, fmtEta, serverBase } from './api.js';
import { t, getLang, setLang, LANGUAGES } from './i18n.js';
import logoUrl from './assets/logo.svg';

const { Text, Paragraph } = Typography;

const QUALITY_OPTIONS = [
  { label: '最佳', value: '' },
  { label: '1080p', value: '1080' },
  { label: '720p', value: '720' },
  { label: '540p', value: '540' },
  { label: '360p', value: '360' },
];

const SITE_TAG_COLOR = {
  youtube: 'red',
  douyin: 'geekblue',
  bilibili: 'magenta',
  xiaohongshu: 'volcano',
  generic: 'default',
};

/* ---------------- 任务卡（memo：进度更新不重建 DOM，杜绝闪烁） ---------------- */
const STATUS_ICON = {
  queued: <ClockCircleOutlined />,
  running: <LoadingOutlined />,
  done: <CheckOutlined />,
  error: <CloseOutlined />,
  paused: <PauseCircleOutlined />,
  cancelled: <StopOutlined />,
};

const STATUS_TEXT_KEY = { queued: 'stQueued', running: 'stRunning', done: 'stDone', error: 'stError', paused: 'stPaused', cancelled: 'stCancelled' };
const stText = (s) => t(STATUS_TEXT_KEY[s] || s);

/* ---- 紧凑任务行（主信息行 + 运行中带完整进度条，点击开详情抽屉） ---- */
const TaskRow = memo(
  function TaskRow({ task, onDetail, onPause, onCancel, onRetry, onDelete }) {
    const pct = Math.min(100, Math.max(0, task.percent || 0));
    const isRunning = task.status === 'running';
    // 运行中始终显示百分比（含 0%），完成后 100%，其他状态按需
    const pctText = task.status === 'done' ? '100%' : isRunning ? pct.toFixed(0) + '%' : pct > 0 ? pct.toFixed(0) + '%' : '';
    const qLabel = task.audio ? 'MP3' : task.quality ? task.quality + 'P' : '';
    const canDelete = !isRunning && task.status !== 'queued';

    return (
      <div className={`trow ${task.status}`} onClick={() => onDetail(task)}>
        <div className="t-line">
          <div className={`tsi ${task.status}`}>{STATUS_ICON[task.status] ?? null}</div>
          <span className="t-title" title={task.title || task.url}>{task.title || midTrunc(task.url, 40, 20)}</span>
          <span className="chip sm">{SITE_LABEL[task.site] || task.site}</span>
          {qLabel && <span className="chip sm q">{qLabel}</span>}
          {isRunning && task.speed > 0 && <span className="t-speed">{fmtSpeed(task.speed)}</span>}
          {task.sizeBytes > 0 && !isRunning && <span className="t-size">{fmtBytes(task.sizeBytes)}</span>}
          {isRunning && task.downloaded > 0 && <span className="t-size">{fmtBytes(task.downloaded)}</span>}
          {pctText && <span className="t-pct">{pctText}</span>}
          <div className="t-actions" onClick={(e) => e.stopPropagation()}>
            {isRunning && (
              <>
                <Button size="small" type="text" data-act="pause" onClick={() => onPause(task.id)}><PauseCircleOutlined /></Button>
                <Button size="small" type="text" data-act="cancel" onClick={() => onCancel(task.id)}><StopOutlined /></Button>
              </>
            )}
            {(task.status === 'error' || task.status === 'paused' || task.status === 'cancelled') && (
              <Button size="small" type="text" data-act="retry" onClick={() => onRetry(task.id)}><ReloadOutlined /></Button>
            )}
            {canDelete && (
              <Popconfirm title="删除此历史记录？" onConfirm={() => onDelete(task.id)} okText="删除" cancelText="取消">
                <Button size="small" type="text" danger><DeleteOutlined /></Button>
              </Popconfirm>
            )}
          </div>
        </div>
        {/* 运行中：行内完整进度条（pct=0 时用 active 动画表示解析中） */}
        {isRunning && (
          <div className="t-bar">
            {pct > 0
              ? <Progress percent={pct} showInfo={false} size={['100%', 5]} />
              : <Progress percent={100} status="active" showInfo={false} size={['100%', 5]} />}
          </div>
        )}
      </div>
    );
  },
  (a, b) => {
    const x = a.task, y = b.task;
    return x === y || (x.id === y.id && x.status === y.status && x.percent === y.percent &&
      x.title === y.title && x.file === y.file && x.error === y.error &&
      x.speed === y.speed && x.downloaded === y.downloaded && x.sizeBytes === y.sizeBytes);
  },
);

/* ---- 详情抽屉 ---- */
function DetailDrawer({ task, onClose, onRetry, onOpen, onReveal, onDelete }) {
  if (!task) return null;
  const pct = task.percent > 0 ? Math.min(100, task.percent) : 0;
  const qLabel = task.audio ? 'MP3' : task.quality ? task.quality + 'P' : '最佳';
  return (
    <Drawer title={task.title || task.url} open={!!task} onClose={onClose} width={420}>
      <Flex vertical gap={12}>
        <Flex gap={8} align="center">
          <span className={`tsi ${task.status}`}>{STATUS_ICON[task.status]}</span>
          <Tag color={task.status === 'done' ? 'success' : task.status === 'error' ? 'error' : task.status === 'running' ? 'processing' : 'default'}>
            {stText(task.status)}
          </Tag>
          <span className="chip">{SITE_LABEL[task.site] || task.site}</span>
          <span className="chip q">{qLabel}</span>
          {task.sizeBytes > 0 && <Text type="secondary">{fmtBytes(task.sizeBytes)}</Text>}
        </Flex>

        {task.status === 'running' && (
          <div>
            <Progress percent={pct} size={['100%', 6]} />
            <Flex justify="space-between" style={{ marginTop: 4 }}>
              {task.speed > 0 && <Text type="secondary">{fmtSpeed(task.speed)}</Text>}
              {task.eta >= 0 && <Text type="secondary">剩余 {fmtEta(task.eta)}</Text>}
            </Flex>
          </div>
        )}

        <div>
          <Text type="secondary" className="tag-label">{t('originalUrl')}</Text>
          <Typography.Paragraph copyable ellipsis style={{ margin: 0 }}>{task.url}</Typography.Paragraph>
        </div>

        {task.file && (
          <div>
            <Text type="secondary" className="tag-label">{t('fileLocation')}</Text>
            <Typography.Paragraph copyable ellipsis style={{ margin: 0 }}>{task.file}</Typography.Paragraph>
          </div>
        )}

        <div>
          <Text type="secondary" className="tag-label">{t('timestamp')}</Text>
          <Text>{new Date(task.createdAt).toLocaleString('zh-CN')}</Text>
        </div>

        {task.error && (
          <div>
            <Text type="secondary" className="tag-label">{t('errorLabel')}</Text>
            <div className="err">{task.error}</div>
          </div>
        )}

        {task.log?.length > 0 && (
          <div>
            <Text type="secondary" className="tag-label">{t('log')} ({task.log.length})</Text>
            <pre className="log-pre">{task.log.join('\n')}</pre>
          </div>
        )}

        <Flex gap={8} wrap="wrap" style={{ marginTop: 8 }}>
          {(task.status === 'error' || task.status === 'paused' || task.status === 'cancelled') && (
            <Button icon={<ReloadOutlined />} onClick={() => onRetry(task.id)}>
              {task.status === 'error' ? '重试' : '恢复'}
            </Button>
          )}
          {task.file && <Button icon={<PlaySquareOutlined />} onClick={() => onOpen(task.file)}>{t('openFile')}</Button>}
          {task.file && <Button icon={<FolderOpenOutlined />} onClick={() => onReveal(task.file)}>{t('openFolder')}</Button>}
          {task.status !== 'running' && task.status !== 'queued' && (
            <Popconfirm title="删除此历史记录？" onConfirm={() => { onDelete(task.id); onClose(); }} okText="删除" cancelText="取消">
              <Button danger icon={<DeleteOutlined />}>删除</Button>
            </Popconfirm>
          )}
        </Flex>
      </Flex>
    </Drawer>
  );
}

/* ---------------- 应用 ---------------- */
export default function App() {
  const { message } = AntApp.useApp();

  const [inputText, setInputText] = useState('');
  const [parsed, setParsed] = useState({ urls: [] });
  const [quality, setQuality] = useState('');
  const [audio, setAudio] = useState(false);
  const [audioDisabled, setAudioDisabled] = useState(false);
  const [outdir, setOutdir] = useState(() => localStorage.getItem('vd.outdir') || '');

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [proxyInput, setProxyInput] = useState('');
  const [sessdataInput, setSessdataInput] = useState('');
  const [proxyStatus, setProxyStatus] = useState(null); // {ok, text}
  const [serverAddr, setServerAddr] = useState(() => localStorage.getItem('vd.server') || '');

  const [tasks, setTasks] = useState(() => new Map());
  const [stats, setStats] = useState(null);
  const [connError, setConnError] = useState(null); // 远程模式连接失败提示
  const [selection, setSelection] = useState(null); // 多视频源选择 {entries, checked, input, outDir}
  const [submitting, setSubmitting] = useState(false);
  const [detailId, setDetailId] = useState(null); // 详情抽屉当前任务 id（实时从 tasks 取，日志/进度跟随 SSE 更新）
  const [langTick, setLangTick] = useState(0); // 语言切换时强制重渲染
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  // 远程模式：启动时探测服务器连通性，失败给明确指引（而非把请求失败当"未识别到链接"）
  useEffect(() => {
    const base = serverBase();
    if (!base) return undefined; // 本机模式无需探测
    let alive = true;
    const probe = () => {
      fetch(base + '/api/config')
        .then((r) => (r.ok ? null : Promise.reject(new Error('HTTP ' + r.status))))
        .then(() => alive && setConnError(null))
        .catch(() => alive && setConnError(base));
    };
    probe();
    const timer = setInterval(probe, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const refreshStats = useCallback(() => {
    fetch(serverBase() + '/api/stats').then((r) => r.json()).then(setStats).catch(() => {});
  }, []);
  useEffect(() => { refreshStats(); }, [refreshStats]);

  // 目录弹窗
  const [dmOpen, setDmOpen] = useState(false);
  const [dm, setDm] = useState({ path: null, parent: null, home: '', entries: [], err: null });

  /* ---- 初始化：配置 + 任务快照 + SSE ---- */
  useEffect(() => {
    api.getConfig().then((c) => {
      setProxyInput(c.proxy || '');
      setSessdataInput(c.bilibiliSessdata || '');
    }).catch(() => {});
    api.getTasks().then((d) => setTasks(new Map(d.tasks.map((t) => [t.id, t])))).catch(() => {});
    const es = new EventSource(serverBase() + '/api/events');
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === 'init') {
        setTasks((prev) => (prev.size === 0 ? new Map(data.tasks.map((t) => [t.id, t])) : prev));
      } else if (data.type === 'task') {
        setTasks((prev) => new Map(prev).set(data.task.id, data.task));
        if (data.task.status === 'done') refreshStats();
      } else if (data.type === 'delete') {
        setTasks((prev) => { const m = new Map(prev); m.delete(data.id); return m; });
        setDetailId((d) => (d === data.id ? null : d));
        refreshStats();
      }
    };
    return () => es.close();
  }, []);

  /* ---- 输入防抖解析 ---- */
  useEffect(() => {
    const text = inputText.trim();
    if (!text) {
      setParsed({ urls: [] });
      return;
    }
    const timer = setTimeout(() => {
      api
        .parse(text)
        .then((r) => {
          setConnError(null);
          setParsed(r);
          const hasDouyin = (r.urls || []).some((u) => u.site === 'douyin');
          setAudioDisabled(hasDouyin);
          if (hasDouyin) setAudio(false);
        })
        .catch(() => {
          // 请求失败 ≠ 未识别到链接：给出可行动的提示
          setParsed({ urls: [] });
          setConnError(serverBase() || '本机服务');
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [inputText]);

  /* ---- 提交下载 ---- */
  const submit = async () => {
    const text = inputText.trim();
    if (!text) {
      message.warning('请先粘贴链接');
      return;
    }
    const od = outdir.trim() || null;
    if (od) localStorage.setItem('vd.outdir', od);
    setSubmitting(true);
    try {
      // 探测是否多视频源（播放列表/合集），是则弹选择框
      const insp = await api.inspect(text).catch(() => ({ multi: false }));
      if (insp.multi && insp.entries?.length > 1) {
        setSelection({ entries: insp.entries, checked: insp.entries.map(() => true), input: text, outDir: od });
        return; // 弹窗等用户确认
      }
      await doDownload(text, od, null);
    } finally {
      setSubmitting(false);
    }
  };

  const doDownload = async (text, od, items) => {
    const r = await api.download({ input: text, quality: quality || null, audio, outDir: od, playlistItems: items });
    if (r.error) message.error(r.error);
    else {
      message.success(`已添加 ${r.tasks.length} 个下载任务${items ? `（选中 ${items.length} 集）` : ''}`);
      setInputText('');
      setParsed({ urls: [] });
      setSelection(null);
    }
  };

  const confirmSelection = async () => {
    if (!selection) return;
    const items = selection.entries.filter((_, i) => selection.checked[i]).map((e) => e.index);
    if (items.length === 0) {
      message.warning('请至少选择一个视频');
      return;
    }
    setSubmitting(true);
    try {
      await doDownload(selection.input, selection.outDir, items);
    } finally {
      setSubmitting(false);
    }
  };

  /* ---- 任务操作 ---- */
  const onRetry = useCallback(async (id) => {
    const r = await api.retry(id).catch(() => null);
    if (r?.error) message.error(r.error);
  }, []);
  const onPause = useCallback(async (id) => {
    const r = await api.pause(id).catch(() => null);
    if (r?.error) message.error(r.error);
  }, []);
  const onCancel = useCallback(async (id) => {
    const r = await api.cancel(id).catch(() => null);
    if (r?.error) message.error(r.error);
  }, []);
  const onOpen = useCallback(async (p) => {
    const r = await api.openFile(p).catch(() => null);
    if (r?.error) message.error(r.error);
  }, []);
  const onReveal = useCallback(async (p) => {
    const r = await api.reveal(p).catch(() => null);
    if (r?.error) message.error(r.error);
  }, []);
  const onDelete = useCallback(async (id) => {
    const r = await api.deleteHistory(id).catch(() => null);
    if (r?.error) message.error(r.error);
    else message.success('已删除');
  }, []);

  /* ---- 浏览目录 ---- */
  const dmLoad = useCallback(async (dir) => {
    setDm((s) => ({ ...s, err: null, entries: [], loading: true }));
    try {
      const data = await api.fsList(dir);
      setDm(data);
    } catch (e) {
      setDm((s) => ({ ...s, err: '读取失败: ' + e.message, loading: false }));
    }
  }, []);

  const browse = async () => {
    let r;
    try {
      r = await api.pickDir();
    } catch (e) {
      message.error('打开目录选择失败: ' + e.message);
      return;
    }
    if (r.native) {
      if (r.path) {
        setOutdir(r.path);
        localStorage.setItem('vd.outdir', r.path);
        message.success('已选择目录');
      }
      return;
    }
    setDmOpen(true);
    const cur = outdir.trim();
    dmLoad(/^[A-Za-z]:[\\/]/.test(cur) ? cur : null);
  };

  const dmConfirm = () => {
    if (!dm.path) {
      message.warning('请先进入一个目录');
      return;
    }
    setOutdir(dm.path);
    localStorage.setItem('vd.outdir', dm.path);
    setDmOpen(false);
    message.success('已选择: ' + dm.path);
  };

  /* ---- 设置 ---- */
  const testProxy = async () => {
    const p = proxyInput.trim();
    if (!p) {
      setProxyStatus({ ok: false, text: '请先输入代理地址' });
      return;
    }
    setProxyStatus({ loading: true, text: '正在测试连接 …' });
    const r = await api.proxyTest(p).catch((e) => ({ error: '测试失败: ' + e.message }));
    if (r.error) {
      setProxyStatus({ ok: false, text: r.error });
      return;
    }
    setProxyStatus({ ok: r.ok, text: r.ok ? `✓ 代理可用（${r.message}，${r.ms}ms）` : `✗ ${r.message}` });
  };
  const saveProxy = async () => {
    const r = await api.saveProxy(proxyInput.trim()).catch(() => null);
    if (r?.error) message.error(r.error);
    else message.success(proxyInput.trim() ? `代理已保存：${proxyInput.trim()}` : '已清除代理配置');
  };
  const saveSessdata = async () => {
    const r = await api.saveSessdata(sessdataInput.trim()).catch(() => null);
    if (r?.error) message.error(r.error);
    else message.success(sessdataInput.trim() ? 'SESSDATA 已保存，B 站将按登录身份下载' : '已清除 SESSDATA（回到游客模式）');
  };

  const taskList = useMemo(
    () => [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt),
    [tasks],
  );
  // 详情抽屉实时任务：SSE 每次更新 tasks 后自动重取（日志/进度实时跟随）
  const detailTask = detailId ? tasks.get(detailId) ?? null : null;
  const audioOn = audio && !audioDisabled;

  return (
    <div className="wrap">
      {/* 顶栏 */}
      <header>
        <div className="logo">
          <img src={logoUrl} alt="logo" />
        </div>
        <div className="ttl">
          <h1>Video Downloader <Tag className="ver">v1.7.0</Tag></h1>
          <div className="sub">YouTube · 抖音 · B站 · 小红书 · 更多站点</div>
        </div>
        <Button
          id="gear"
          className={`gear${settingsOpen ? ' on' : ''}`}
          shape="default"
          icon={<SettingOutlined />}
          onClick={() => setSettingsOpen((v) => !v)}
          title={t('settings')}
        />
      </header>

      {/* 设置面板 */}
      <div id="settings" className={`settings${settingsOpen ? ' open' : ''}`}>
        <Card size="small">
          <Flex vertical gap={4}>
            <Text type="secondary" className="tag-label">网络代理（HTTP / SOCKS5）</Text>
            <Flex gap={8} wrap="wrap">
              <Input
                id="proxy-input"
                style={{ flex: 1, minWidth: 220 }}
                placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
                value={proxyInput}
                onChange={(e) => setProxyInput(e.target.value)}
              />
              <Button id="proxy-test" onClick={testProxy}>测试</Button>
              <Button id="proxy-save" type="primary" onClick={saveProxy}>保存</Button>
            </Flex>
            <div id="proxy-status" className={proxyStatus ? (proxyStatus.ok ? 'ok' : 'bad') : ''}>
              {proxyStatus?.text}
            </div>
            <Text type="secondary" className="note">仅对 YouTube 等 yt-dlp 站点生效；抖音/小红书为国内直连。留空即不使用代理。</Text>

            <Text type="secondary" className="tag-label" style={{ marginTop: 8 }}>哔哩哔哩 登录（SESSDATA，可选）</Text>
            <Flex gap={8} wrap="wrap">
              <Input
                id="sessdata-input"
                style={{ flex: 1, minWidth: 220 }}
                placeholder="粘贴浏览器 Cookie 中的 SESSDATA 值，解锁 720p 及以上清晰度"
                value={sessdataInput}
                onChange={(e) => setSessdataInput(e.target.value)}
              />
              <Button id="sessdata-save" type="primary" onClick={saveSessdata}>保存</Button>
            </Flex>
            <Text type="secondary" className="note">获取：B 站网页版登录 → F12 → 应用 → Cookie → 复制 SESSDATA 的值。</Text>

            <Text type="secondary" className="tag-label" style={{ marginTop: 8 }}>{t('remoteTitle')}</Text>
            <Flex gap={8} wrap="wrap">
              <Input
                id="server-input"
                style={{ flex: 1, minWidth: 220 }}
                placeholder="http://192.168.1.100:8321 （桌面端 node gui.mjs --lan 显示的地址）"
                value={serverAddr}
                onChange={(e) => setServerAddr(e.target.value)}
              />
              <Button
                id="server-save"
                type="primary"
                onClick={() => {
                  localStorage.setItem('vd.server', serverAddr.trim());
                  message.success(serverAddr.trim() ? '已保存，页面即将刷新以连接服务器' : '已清除，回到本机模式');
                  setTimeout(() => location.reload(), 800);
                }}
              >
                保存
              </Button>
            </Flex>
            <Text type="secondary" className="note">安卓 App / 手机浏览器（PWA）连桌面服务时填；桌面本机使用请留空。</Text>

            <Text type="secondary" className="tag-label" style={{ marginTop: 8 }}>{t('language')}</Text>
            <Segmented
              options={LANGUAGES}
              value={getLang()}
              onChange={(v) => { setLang(v); setLangTick((x) => x + 1); }}
            />
          </Flex>
        </Card>
      </div>

      {/* 远程模式连接失败横幅 */}
      {connError && serverBase() && (
        <Alert
          className="conn-alert"
          type="error"
          showIcon
          message={`无法连接服务器 ${connError}`}
          description="请确认：① 桌面端已运行 node gui.mjs --lan；② 手机与电脑在同一 Wi-Fi；③ ⚙ 设置里的服务器地址正确（形如 http://192.168.1.19:8321）。"
          closable={false}
        />
      )}

      {/* 输入区 */}
      <Card>
        <Text type="secondary" className="tag-label">{t('inputLabel')}</Text>
        <Input.TextArea
          id="input"
          rows={3}
          placeholder={'粘贴视频链接，或整段抖音/小红书分享口令（自动识别其中的链接）\n支持一次粘贴多条，Ctrl+Enter 快速开始'}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
          }}
        />
        <div className="detected">
          {parsed.urls?.map((u, i) => (
            <Tag key={i} color={SITE_TAG_COLOR[u.site]} bordered>
              {SITE_LABEL[u.site] || u.site}
            </Tag>
          ))}
          {parsed.urls?.length > 0 && <span className="count">共 {parsed.urls.length} 条</span>}
          {inputText.trim() && parsed.urls?.length === 0 && connError && serverBase() && (
            <Tag color="error">无法连接服务器，请检查远程模式设置</Tag>
          )}
          {inputText.trim() && parsed.urls?.length === 0 && !(connError && serverBase()) && <Tag>未识别到链接</Tag>}
        </div>

        <Flex gap={14} wrap="wrap" align="flex-end" className="controls">
          <Flex vertical gap={7}>
            <Text type="secondary" className="tag-label">{t('quality')}</Text>
            <div id="quality" className={audioOn ? 'seg disabled' : 'seg'}>
              <Segmented
                options={QUALITY_OPTIONS}
                value={quality}
                onChange={(v) => setQuality(v)}
                disabled={audioOn}
              />
            </div>
          </Flex>

          <Flex vertical gap={7}>
            <Text type="secondary" className="tag-label">{t('format')}</Text>
            <Flex align="center" gap={9} style={{ height: 32 }}>
              <Switch
                id="audio"
                size="small"
                checked={audio}
                disabled={audioDisabled}
                onChange={setAudio}
              />
              <span>{t('audioOnly')}</span>
              <Text type="secondary" style={{ fontSize: 11 }}>mp3</Text>
            </Flex>
          </Flex>

          <Flex vertical gap={7} style={{ flex: 1, minWidth: 230 }}>
            <Text type="secondary" className="tag-label">{t('saveTo')}</Text>
            <Flex gap={8}>
              <Input
                id="outdir"
                placeholder="downloads/"
                value={outdir}
                title={outdir}
                onChange={(e) => {
                  setOutdir(e.target.value);
                  localStorage.setItem('vd.outdir', e.target.value.trim());
                }}
              />
              <Button id="dir-browse" icon={<FolderOpenOutlined />} onClick={browse}>{t('browse')}</Button>
              <Button
                id="dir-reset"
                onClick={() => {
                  setOutdir('');
                  localStorage.removeItem('vd.outdir');
                  message.success('已恢复默认目录 downloads/');
                }}
              >
                重置
              </Button>
            </Flex>
          </Flex>

          <Button id="btn" type="primary" icon={<DownloadOutlined />} onClick={submit} loading={submitting}>
            {submitting ? t('inspecting') : t('startDownload')}
          </Button>
        </Flex>
      </Card>

      {/* 任务区 */}
      <div className="section-head">
        <h2>{t('tasks')}</h2>
        <span className="line" />
        {stats && (
          <span className="stats-chip" title="基于下载历史的累计统计">
            累计 {stats.totalFiles} 个 · {fmtBytes(stats.totalBytes) || '0 B'}
          </span>
        )}
      </div>
      {taskList.length === 0 ? (
        <div className="empty">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<>还没有任务 —— 粘贴链接，按 <Text keyboard>Ctrl</Text>+<Text keyboard>Enter</Text> 快速开始</>} />
        </div>
      ) : (
        <div className="tlist">
          {taskList.map((t) => (
            <TaskRow key={t.id} task={t} onDetail={(row) => setDetailId(row.id)} onPause={onPause} onCancel={onCancel} onRetry={onRetry} onDelete={onDelete} />
          ))}
        </div>
      )}

      {/* 详情抽屉 */}
      <DetailDrawer
        task={detailTask}
        onClose={() => setDetailId(null)}
        onRetry={onRetry}
        onOpen={onOpen}
        onReveal={onReveal}
        onDelete={onDelete}
      />

      <footer>
        CLI 方式同样可用：<code>node cli.mjs &lt;链接/口令&gt; [-q 1080] [--audio] [-o 目录]</code>
        <br />下载文件统一优先 H.264 编码，保证系统播放器可直接播放
      </footer>

      {/* 多视频源选择弹窗 */}
      <Modal
        title={`选择要下载的视频（共 ${selection?.entries?.length ?? 0} 个）`}
        open={!!selection}
        onCancel={() => setSelection(null)}
        width={620}
        footer={[
          <Button key="cancel" onClick={() => setSelection(null)}>取消</Button>,
          <Button key="all" onClick={() => setSelection((s) => s && { ...s, checked: s.entries.map(() => true) })}>{t('selectAll')}</Button>,
          <Button key="none" onClick={() => setSelection((s) => s && { ...s, checked: s.entries.map(() => false) })}>{t('selectNone')}</Button>,
          <Button key="ok" type="primary" onClick={confirmSelection} loading={submitting}>
            下载选中（{selection?.checked?.filter(Boolean).length ?? 0} 个）
          </Button>,
        ]}
      >
        <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          <List
            size="small"
            dataSource={selection?.entries ?? []}
            renderItem={(item, idx) => (
              <List.Item
                actions={[
                  <Checkbox
                    key="chk"
                    checked={selection?.checked?.[idx]}
                    onChange={(e) =>
                      setSelection((s) => {
                        if (!s) return s;
                        const c = [...s.checked];
                        c[idx] = e.target.checked;
                        return { ...s, checked: c };
                      })
                    }
                  />,
                ]}
              >
                <List.Item.Meta
                  title={<Text ellipsis style={{ maxWidth: 420 }}>{item.title}</Text>}
                  description={`#${item.index}${item.duration ? ` · ${fmtEta(item.duration)}` : ''}`}
                />
              </List.Item>
            )}
          />
        </div>
      </Modal>

      {/* 目录选择弹窗（网页模式） */}
      <Modal
        title="选择保存目录"
        open={dmOpen}
        onCancel={() => setDmOpen(false)}
        width={560}
        footer={[
          <Button key="cancel" id="dm-cancel" onClick={() => setDmOpen(false)}>取消</Button>,
          <Button key="ok" id="dm-ok" type="primary" onClick={dmConfirm}>选择此目录</Button>,
        ]}
      >
        <Flex gap={8} align="center" style={{ marginBottom: 12 }}>
          <Button id="dm-home" icon={<HomeOutlined />} disabled={!dm.path} onClick={() => dm.home && dmLoad(dm.home)} />
          <Button id="dm-up" icon={<ArrowUpOutlined />} disabled={!dm.path} onClick={() => dmLoad(dm.parent)}>
            上级
          </Button>
          <div id="dm-path" className="dm-path" title={dm.path || ''}>{dm.path || '此电脑'}</div>
        </Flex>
        <div className="dm-list">
          {dm.loading && <div className="dm-empty">加载中 …</div>}
          {!dm.loading && dm.err && <div className="dm-empty">⚠️ {dm.err}</div>}
          {!dm.loading && !dm.err && dm.entries?.length === 0 && <div className="dm-empty">（空目录）</div>}
          {!dm.loading && !dm.err && dm.entries?.map((e) => (
            <div
              key={e.path}
              className="dm-item"
              onClick={() => dmLoad(e.path)}
            >
              <span className="ico">{e.name === '主目录' ? '🏠' : /^[A-Z]:\\?$/i.test(e.name) ? '💽' : '📁'}</span>
              <span>{e.name}</span>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
