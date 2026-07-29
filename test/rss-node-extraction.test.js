import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pool-rss-nodes-'));
const { extractProxyLinesFromRssContent } = await import('../src/services/rss.js');

const vmessUri = 'vmess://' + Buffer.from(JSON.stringify({
  v: '2', ps: '测试节点', add: '1.2.3.4', port: '443',
  id: '11111111-2222-3333-4444-555555555555', aid: '0', net: 'ws', type: 'none', host: '', path: '/', tls: 'tls',
})).toString('base64');

test('node-sharing posts yield vmess/vless/hysteria2/trojan/ss nodes', () => {
  const post = `
    <p>今天分享几个免费节点，自用直接复制：</p>
    <pre><code>${vmessUri}
vless://22222222-3333-4444-5555-666666666666@5.6.7.8:443?security=tls&amp;sni=example.com&amp;type=ws&amp;path=%2Fws#香港01
hysteria2://mypassword@9.9.9.9:8443?sni=example.org#日本01
trojan://trojanpass@4.4.4.4:443?sni=example.net#美国01
ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@8.8.4.4:8388#新加坡01</code></pre>
    <p>另外还有个 http 代理：203.0.113.7:8080</p>
  `;

  const lines = extractProxyLinesFromRssContent(post, 'http');
  const joined = lines.join('\n');

  assert.ok(joined.includes(vmessUri), 'vmess 链接应原样保留');
  assert.match(joined, /vless:\/\/22222222-3333-4444-5555-666666666666@5\.6\.7\.8:443/);
  assert.match(joined, /hysteria2:\/\/mypassword@9\.9\.9\.9:8443/);
  assert.match(joined, /trojan:\/\/trojanpass@4\.4\.4\.4:443/);
  assert.match(joined, /ss:\/\//);
  assert.ok(lines.includes('http://203.0.113.7:8080'), '裸 ip:port 仍按默认协议导入');
});

test('URI parameters survive extraction so sing-box can dial the node', () => {
  const post = `<pre>vless://22222222-3333-4444-5555-666666666666@5.6.7.8:443?security=tls&amp;sni=example.com&amp;type=ws&amp;path=%2Fws#节点</pre>`;
  const [line] = extractProxyLinesFromRssContent(post, 'http');
  assert.match(line, /security=tls/);
  assert.match(line, /sni=example\.com/);
  assert.match(line, /path=%2Fws/);
});

test('a pasted base64 subscription blob is decoded', () => {
  const blob = Buffer.from([
    'vless://33333333-4444-5555-6666-777777777777@11.22.33.44:443?security=tls#订阅节点1',
    'trojan://pass2@55.66.77.88:443#订阅节点2',
  ].join('\n')).toString('base64');
  const post = `<p>订阅内容如下：</p><pre><code>${blob}</code></pre>`;

  const lines = extractProxyLinesFromRssContent(post, 'http');
  assert.match(lines.join('\n'), /11\.22\.33\.44:443/);
  assert.match(lines.join('\n'), /55\.66\.77\.88:443/);
});

test('LAN and loopback examples in forum prose are still ignored', () => {
  const post = `
    <p>把代理配置成 127.0.0.1:7890 就行，内网的是 192.168.1.10:8080</p>
    <pre>vless://44444444-5555-6666-7777-888888888888@10.0.0.5:443#内网节点</pre>
  `;
  assert.deepEqual(extractProxyLinesFromRssContent(post, 'http'), []);
});

test('duplicate nodes across posts are collapsed once', () => {
  const post = `<pre>${vmessUri}\n${vmessUri}</pre>`;
  assert.equal(extractProxyLinesFromRssContent(post, 'http').length, 1);
});

const { topicScore } = await import('../src/services/rss.js');

test('only proxy-looking posts spend the topic fetch budget', () => {
  // 用户要的关键词：HTTP 代理 / 住宅 / 代理池 等，标题命中即抓
  assert.equal(topicScore('免费节点分享，自取'), 2);
  assert.equal(topicScore('出一批静态住宅代理'), 2);
  assert.equal(topicScore('分享几个 http 代理'), 2);
  assert.equal(topicScore('自建代理池教程'), 2);
  assert.equal(topicScore('clash 订阅转换工具'), 2);

  // 沾边但值得一看：代理名词 + 免费/分享类词
  assert.equal(topicScore('免费机场推荐'), 2);
  assert.equal(topicScore('求个便宜订阅，分享下经验'), 1);

  // 完全无关的帖子不该消耗抓取预算
  assert.equal(topicScore('分享 ai 笑话一则'), 0);
  assert.equal(topicScore('关于苹果订阅的 claude 会员被封号'), 0);
  assert.equal(topicScore('claude pro 和 gpt plus 额度对比'), 0);
  assert.equal(topicScore('fedora 的安装比 arch 简单'), 0);
});
