import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  // 1. VPS 上报接口
  if (req.method === 'POST' && req.query.action === 'report') {
    const { name, total_gb, max_gb, rx_gb, tx_gb, cpu, ram, ip } = req.body;
    if (!name) return res.status(400).send("No name");

    const now = Date.now();
    await redis.set(`node:${name}`, { ...req.body, updated_at: now }, { ex: 604800 });

    // 流量超标检测并推送到 Telegram
    if (max_gb && total_gb >= max_gb && process.env.TG_TOKEN && process.env.TG_CHAT_ID) {
      const today = new Date().toISOString().slice(0, 10);
      const alerted = await redis.get(`alert:${name}:${today}`);
      if (!alerted) {
        const text = `🚨【VPS流量警报】\n节点: ${name}\nIP: ${ip}\n已用: ${total_gb}GB / 上限: ${max_gb}GB\n出站: ${tx_gb}GB | 入站: ${rx_gb}GB`;
        await fetch(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: process.env.TG_CHAT_ID, text })
        });
        await redis.set(`alert:${name}:${today}`, 1, { ex: 86400 });
      }
    }
    return res.status(200).json({ status: "ok" });
  }

  // 2. 数据接口 (供前端获取)
  if (req.query.action === 'list') {
    const keys = await redis.keys('node:*');
    const nodes = [];
    const now = Date.now();
    for (const k of keys) {
      const val = await redis.get(k);
      if (val) {
        val.online = (now - val.updated_at) < 180000; // 3分钟未上报判定离线
        nodes.push(val);
      }
    }
    return res.status(200).json(nodes);
  }

  // 3. 根目录直接渲染暗黑大屏仪表盘
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(`<!DOCTYPE html>
<html class="dark"><head><meta charset="utf-8"><title>VPS 状态看板</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-950 text-slate-100 p-8 font-sans">
  <div class="max-w-6xl mx-auto">
    <div class="flex justify-between items-center pb-6 border-b border-gray-800 mb-8">
      <h1 class="text-xl font-bold flex items-center gap-2"><span class="w-3 h-3 bg-emerald-500 rounded-full animate-pulse"></span>VPS 节点与流量监视看板</h1>
      <button onclick="load()" class="text-xs bg-gray-900 border border-gray-800 px-3 py-1.5 rounded-lg hover:bg-gray-800 transition">刷新</button>
    </div>
    <div id="grid" class="grid grid-cols-1 md:grid-cols-3 gap-6"></div>
  </div>
  <script>
    async function load() {
      const res = await fetch('/api?action=list');
      const data = await res.json();
      const grid = document.getElementById('grid');
      if (!data || data.length === 0) {
        grid.innerHTML = '<div class="text-gray-500 text-xs col-span-full text-center py-12">暂无节点数据，等待 VPS 上报...</div>';
        return;
      }
      grid.innerHTML = data.map(n => {
        const pct = Math.min(100, Math.round(((n.total_gb || 0) / (n.max_gb || 100)) * 100));
        const danger = pct >= 85;
        return '<div class="border border-gray-800 bg-gray-900/60 p-5 rounded-xl">' +
          '<div class="flex justify-between items-center mb-3"><b class="text-white">' + n.name + '</b><span class="text-[10px] px-2 py-0.5 rounded font-mono ' + (n.online ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400') + '">' + (n.online ? 'ONLINE' : 'OFFLINE') + '</span></div>' +
          '<div class="text-xs text-gray-400 mb-4 flex justify-between font-mono"><span>IP: ' + (n.ip || '--') + '</span><span>CPU: ' + (n.cpu || '0%') + ' | 内存: ' + (n.ram || '0%') + '</span></div>' +
          '<div class="bg-gray-950 p-3 rounded-lg border border-gray-800">' +
            '<div class="flex justify-between text-xs mb-1"><span>流量消耗</span><span class="' + (danger ? 'text-red-400 font-bold' : '') + '">' + n.total_gb + 'G / ' + n.max_gb + 'G (' + pct + '%)</span></div>' +
            '<div class="w-full bg-gray-800 h-2 rounded-full overflow-hidden"><div class="h-full ' + (danger ? 'bg-red-500' : 'bg-blue-500') + '" style="width:' + pct + '%"></div></div>' +
            '<div class="flex justify-between text-[10px] text-gray-500 mt-2 font-mono"><span>↓ ' + n.rx_gb + 'G</span><span>↑ ' + n.tx_gb + 'G</span></div>' +
          '</div>' +
        '</div>';
      }).join('');
    }
    load(); setInterval(load, 15000);
  </script>
</body></html>`);
}
