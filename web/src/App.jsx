import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  Empty,
  Flex,
  Input,
  Modal,
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
  DownloadOutlined,
  FolderOpenOutlined,
  HomeOutlined,
  LoadingOutlined,
  ReloadOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { api, midTrunc, SITE_LABEL } from './api.js';

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
};

const TaskCard = memo(
  function TaskCard({ t, onRetry, onReveal }) {
  const pct = t.percent > 0 ? Math.min(100, t.percent) : 0;
  const pctText = t.status === 'done' ? '100%' : pct > 0 ? pct.toFixed(1) + '%' : '—';
  const qLabel = t.audio ? 'MP3' : t.quality ? t.quality + 'P' : '最佳';
  const fileName = t.file ? midTrunc(t.file.split(/[\\/]/).pop()) : '';
  const stage = t.status === 'running' ? t.stage || '' : t.status === 'queued' ? '排队中' : '';

  return (
    <div className={`task ${t.status}`}>
      <div className="row1">
        <div className={`sticon ${t.status}`}>{STATUS_ICON[t.status] ?? null}</div>
        <div className="main">
          <div className="title" title={t.title || t.url}>{t.title || t.url}</div>
          <div className="meta">
            <span className="chip">{SITE_LABEL[t.site] || t.site}</span>
            <span className="chip q">{qLabel}</span>
            <span className="stage-text">{stage}</span>
          </div>
        </div>
      </div>
      {t.status === 'running' && pct === 0 ? (
        <Progress className="bar" percent={100} status="active" showInfo={false} size={['100%', 6]} />
      ) : (
        <Progress className="bar" percent={pct} showInfo={false} size={['100%', 6]} />
      )}
      <div className="foot">
        <span className="file" title={t.file || ''}>{fileName}</span>
        <span className="pct">{pctText}</span>
        <div className="actions">
          {t.status === 'error' && (
            <Button size="small" type="text" data-act="retry" onClick={() => onRetry(t.id)}>
              <ReloadOutlined /> 重试
            </Button>
          )}
          {t.file && (
            <Button size="small" type="text" onClick={() => onReveal(t.file)}>
              打开文件夹
            </Button>
          )}
          {t.file && (
            <Button size="small" type="text" onClick={() => navigator.clipboard.writeText(t.file)}>
              复制路径
            </Button>
          )}
        </div>
      </div>
      {t.error && <div className="err">{t.error}</div>}
      {t.log?.length > 0 && (
        <details className="log">
          <summary>▸ 日志 ({t.log.length})</summary>
          <pre>{t.log.join('\n')}</pre>
        </details>
      )}
    </div>
  );
  },
  // 值比较器：SSE 每次推送都是新对象，默认引用比较会让全部卡片白渲染；
  // 按字段比较后，A 任务下载时 B/C 任务卡完全不重渲染（悬停态/日志展开零打扰）
  (a, b) => {
    const x = a.t;
    const y = b.t;
    return (
      x === y ||
      (x.id === y.id &&
        x.status === y.status &&
        x.percent === y.percent &&
        x.stage === y.stage &&
        x.title === y.title &&
        x.file === y.file &&
        x.error === y.error &&
        x.log?.length === y.log?.length &&
        x.quality === y.quality &&
        x.audio === y.audio)
    );
  },
);

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

  const [tasks, setTasks] = useState(() => new Map());
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

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
    const es = new EventSource('/api/events');
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === 'init') {
        // init 是连接快照：仅当本地为空时应用，避免断线重连时清空重建列表（闪烁/节点重建）
        setTasks((prev) => (prev.size === 0 ? new Map(data.tasks.map((t) => [t.id, t])) : prev));
      } else if (data.type === 'task') {
        setTasks((prev) => new Map(prev).set(data.task.id, data.task));
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
      api.parse(text).then((r) => {
        setParsed(r);
        const hasDouyin = (r.urls || []).some((u) => u.site === 'douyin');
        setAudioDisabled(hasDouyin);
        if (hasDouyin) setAudio(false);
      }).catch(() => {});
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
    const r = await api.download({ input: text, quality: quality || null, audio, outDir: od });
    if (r.error) message.error(r.error);
    else {
      message.success(`已添加 ${r.tasks.length} 个下载任务`);
      setInputText('');
      setParsed({ urls: [] });
    }
  };

  /* ---- 任务操作 ---- */
  const onRetry = useCallback(async (id) => {
    const r = await api.retry(id).catch(() => null);
    if (r?.error) message.error(r.error);
  }, []);
  const onReveal = useCallback(async (p) => {
    const r = await api.reveal(p).catch(() => null);
    if (r?.error) message.error(r.error);
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
  const audioOn = audio && !audioDisabled;

  return (
    <div className="wrap">
      {/* 顶栏 */}
      <header>
        <div className="logo">
          <DownloadOutlined />
        </div>
        <div className="ttl">
          <h1>Video Downloader <Tag className="ver">v0.4</Tag></h1>
          <div className="sub">YouTube · 抖音 · B站 · 小红书 · 更多站点</div>
        </div>
        <Button
          id="gear"
          className={`gear${settingsOpen ? ' on' : ''}`}
          shape="default"
          icon={<SettingOutlined />}
          onClick={() => setSettingsOpen((v) => !v)}
          title="设置（网络代理 / B站登录）"
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
          </Flex>
        </Card>
      </div>

      {/* 输入区 */}
      <Card>
        <Text type="secondary" className="tag-label">视频链接 / 分享口令（支持多条，混合站点）</Text>
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
          {inputText.trim() && parsed.urls?.length === 0 && <Tag>未识别到链接</Tag>}
        </div>

        <Flex gap={14} wrap="wrap" align="flex-end" className="controls">
          <Flex vertical gap={7}>
            <Text type="secondary" className="tag-label">清晰度</Text>
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
            <Text type="secondary" className="tag-label">格式</Text>
            <Flex align="center" gap={9} style={{ height: 32 }}>
              <Switch
                id="audio"
                size="small"
                checked={audio}
                disabled={audioDisabled}
                onChange={setAudio}
              />
              <span>仅音频</span>
              <Text type="secondary" style={{ fontSize: 11 }}>mp3</Text>
            </Flex>
          </Flex>

          <Flex vertical gap={7} style={{ flex: 1, minWidth: 230 }}>
            <Text type="secondary" className="tag-label">保存到</Text>
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
              <Button id="dir-browse" icon={<FolderOpenOutlined />} onClick={browse}>浏览…</Button>
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

          <Button id="btn" type="primary" icon={<DownloadOutlined />} onClick={submit}>
            开始下载
          </Button>
        </Flex>
      </Card>

      {/* 任务区 */}
      <div className="section-head"><h2>下载任务</h2><span className="line" /></div>
      {taskList.length === 0 ? (
        <div className="empty">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<>还没有任务 —— 粘贴链接，按 <Text keyboard>Ctrl</Text>+<Text keyboard>Enter</Text> 快速开始</>} />
        </div>
      ) : (
        taskList.map((t) => <TaskCard key={t.id} t={t} onRetry={onRetry} onReveal={onReveal} />)
      )}

      <footer>
        CLI 方式同样可用：<code>node cli.mjs &lt;链接/口令&gt; [-q 1080] [--audio] [-o 目录]</code>
        <br />下载文件统一优先 H.264 编码，保证系统播放器可直接播放
      </footer>

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
