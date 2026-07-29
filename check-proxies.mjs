#!/usr/bin/env node
/**
 * 代理检测脚本
 * 1. 检测 IP 类型（residential/datacenter/mobile）
 * 2. 活跃检测（是否能连通）
 */

import { initDb, getDb, listProxies, upsertProxy, getSetting } from './src/db.js';
import { testProxy, inspectIspInfoThroughProxy } from './src/services/tester.js';

const DB_PATH = process.env.DB_PATH || './data/proxy-pool.db';

async function main() {
  console.log('=== 代理检测脚本 ===\n');

  // 初始化数据库
  initDb();

  // 获取所有代理
  const proxies = listProxies({ limit: 0 });
  console.log(`共 ${proxies.length} 个代理需要检测\n`);

  if (proxies.length === 0) {
    console.log('没有代理需要检测');
    process.exit(0);
  }

  // 统计
  const stats = {
    total: proxies.length,
    alive: 0,
    dead: 0,
    residential: 0,
    datacenter: 0,
    mobile: 0,
    unknown: 0,
  };

  // 逐个检测
  for (let i = 0; i < proxies.length; i++) {
    const proxy = proxies[i];
    console.log(`\n[${i + 1}/${proxies.length}] 检测 ${proxy.ip}:${proxy.port} (${proxy.protocol})`);

    try {
      // 1. 活跃检测
      console.log('  → 活跃检测...');
      const testResult = await testProxy(proxy);

      if (testResult.alive) {
        stats.alive++;
        console.log(`  ✓ 存活，出口 IP: ${testResult.exitIp || 'unknown'}，延迟: ${testResult.responseTime}ms`);
        upsertProxy({
          ...proxy,
          alive: true,
          exitIp: testResult.exitIp || null,
          responseTime: testResult.responseTime,
          anonymity: testResult.anonymity,
          lastCheckAt: new Date().toISOString(),
        });

        // 2. IP 类型检测（仅对存活代理）
        console.log('  → IP 类型检测...');
        const ispResult = await inspectIspInfoThroughProxy(proxy);

        if (ispResult.status === 'success' && ispResult.normalized) {
          const n = ispResult.normalized;
          let ipType = 'unknown';
          if (n.isMobile) {
            ipType = 'mobile';
            stats.mobile++;
          } else if (n.isDatacenter) {
            ipType = 'datacenter';
            stats.datacenter++;
          } else {
            ipType = 'residential';
            stats.residential++;
          }

          console.log(`  ✓ IP 类型: ${ipType}`);
          console.log(`    国家: ${n.country || 'unknown'} (${n.countryCode || ''})`);
          console.log(`    ASN: ${n.asn || 'unknown'} - ${n.asnOrg || ''}`);

          upsertProxy({
            ...proxy,
            ipType: ipType,
            country: n.countryCode || 'unknown',
            countryName: n.country || '',
            asn: n.asn || '',
            asName: n.asnOrg || '',
            isp: n.companyName || '',
            lastClassifiedAt: new Date().toISOString(),
          });
        } else {
          stats.unknown++;
          console.log(`  ✗ IP 类型检测失败: ${ispResult.error || 'unknown'}`);
        }
      } else {
        stats.dead++;
        console.log(`  ✗ 失败: ${testResult.error || testResult.errorCategory || 'unknown'}`);
        upsertProxy({
          ...proxy,
          alive: false,
          lastCheckAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      stats.dead++;
      console.log(`  ✗ 检测异常: ${err.message}`);
      upsertProxy({
        ...proxy,
        alive: false,
        lastCheckAt: new Date().toISOString(),
      });
    }

    // 短暂延迟，避免过载
    await new Promise(r => setTimeout(r, 500));
  }

  // 输出统计结果
  console.log('\n\n=== 检测完成 ===');
  console.log(`总计: ${stats.total}`);
  console.log(`存活: ${stats.alive}`);
  console.log(`失效: ${stats.dead}`);
  console.log(`---`);
  console.log(`住宅: ${stats.residential}`);
  console.log(`机房: ${stats.datacenter}`);
  console.log(`移动: ${stats.mobile}`);
  console.log(`未知: ${stats.unknown}`);

  process.exit(0);
}

main().catch(err => {
  console.error('脚本执行失败:', err);
  process.exit(1);
});