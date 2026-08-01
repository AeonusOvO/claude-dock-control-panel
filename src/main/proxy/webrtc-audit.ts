import { BrowserWindow } from 'electron';
import type { ProxyAuditItem } from '../../shared/contracts';

export interface IceCandidateEvidence {
  address: string;
  type: 'host' | 'srflx';
}

export const extractIceCandidates = (candidates: string[]): IceCandidateEvidence[] => {
  const result: IceCandidateEvidence[] = [];
  for (const candidate of candidates) {
    const match = candidate.match(
      /candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+\s+typ\s+(host|srflx)\b/i,
    );
    if (match?.[1] && (match[2] === 'host' || match[2] === 'srflx')) {
      result.push({ address: match[1], type: match[2] });
    }
  }
  return result;
};

export const evaluateWebRtcCandidates = (
  candidates: IceCandidateEvidence[],
  expectedProxyIp?: string,
): ProxyAuditItem => {
  const reflected = candidates.filter(({ type }) => type === 'srflx');
  const unexpected = reflected.filter(
    ({ address }) => !expectedProxyIp || address !== expectedProxyIp,
  );
  const hostCount = candidates.filter(({ type }) => type === 'host').length;
  if (unexpected.length > 0) {
    return {
      advice: '保持 disable_non_proxied_udp 策略；关闭其他可创建 WebRTC 连接的未代理页面后重试。',
      evidence: [
        `期望代理出口：${expectedProxyIp ?? '未知'}`,
        ...unexpected.map(({ address }) => `发现反射地址：${address}`),
        `host 候选：${hostCount} 个`,
      ],
      explanation:
        'ClaudeDock 的隐藏检测页发现与代理出口不一致的 srflx 候选。此项仅覆盖 ClaudeDock 自身 WebContents；Node CLI 不使用 WebRTC，系统浏览器由其自身策略控制。',
      name: 'WebRTC 泄露',
      verdict: 'risk',
    };
  }
  return {
    advice: '系统浏览器 OAuth 页面仍需依赖浏览器自己的 WebRTC 隐私设置。',
    evidence: [
      reflected.length === 0
        ? '未发现 srflx 候选（未代理 UDP 已禁用）'
        : `srflx 与期望出口一致：${expectedProxyIp}`,
      `host 候选：${hostCount} 个`,
    ],
    explanation:
      'ClaudeDock 对所有 WebContents 应用 disable_non_proxied_udp。Claude Code / Codex CLI 是 Node 进程，不使用 WebRTC。',
    name: 'WebRTC 泄露',
    verdict: 'passed',
  };
};

export const auditWebRtc = async (expectedProxyIp?: string): Promise<ProxyAuditItem> => {
  const window = new BrowserWindow({
    height: 1,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
    width: 1,
  });
  window.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  try {
    await window.loadURL('data:text/html,<meta charset="utf-8"><title>WebRTC audit</title>');
    const candidates = (await window.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const values = [];
        const connection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
        const finish = () => { connection.close(); resolve(values); };
        const timer = setTimeout(finish, 5000);
        connection.onicecandidate = (event) => {
          if (event.candidate) values.push(event.candidate.candidate);
          else { clearTimeout(timer); finish(); }
        };
        connection.createDataChannel('audit');
        connection.createOffer().then((offer) => connection.setLocalDescription(offer)).catch(finish);
      })
    `)) as string[];
    return evaluateWebRtcCandidates(extractIceCandidates(candidates), expectedProxyIp);
  } catch (error) {
    return {
      advice: '稍后重试；策略已生效，但本次隐藏页没有形成可判读的 ICE 证据。',
      evidence: [error instanceof Error ? error.message : 'WebRTC 隐藏页检测失败。'],
      explanation: '检测失败不会撤销已经应用到 WebContents 的 UDP 限制。',
      name: 'WebRTC 泄露',
      verdict: 'warning',
    };
  } finally {
    window.destroy();
  }
};
