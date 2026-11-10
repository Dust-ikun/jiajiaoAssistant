/**
 * 城市推断 + 降级匹配回归（纯函数，零 IO、零网络、零配额）。
 *
 * 【为什么单独一个文件】这两个函数管的是「拿哪个城市去查」和「查回来的坐标敢不敢用」，
 * 是通勤链路上唯一能**错得看起来很正常**的地方：
 *   - 城市判错 → 在另一个城市里查，跨城能差出几小时，界面上却只显示一个普通数字；
 *   - 降级放行 → 拿整个区的几何中心当小区，差二十分钟而区名全对，肉眼查不出来。
 * 两件事都不联网就能断言，所以必须在这里钉死。
 *
 * 【为什么先钉「越秀区中山一路梅花村」】实测这串地址被城市词表里的「中山」吃掉了前半截，
 * 判成广东省中山市，于是高德在中山查到的「中山一路」反而通过了城市对账，
 * 最终只能报「只匹配到广东省中山市中山一路」。城市名与路名同形是**系统性**的坑
 * （中山一路/中山大道/东莞庄路），不是一条地址的意外。
 *
 * 运行：node src/commute/city.test.ts
 */
import { inferCity, isDowngradedMatch, normalizeCity, poiNameCoverage } from './city.ts';

let failed = 0;
let passed = 0;

function check(name: string, actual: unknown, expect: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) {
    passed++;
    return;
  }
  failed++;
  console.log(`  ✗ ${name}\n      期望: ${JSON.stringify(expect)}\n      实际: ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ *
 * 一、城市词的「假阳性」：路名吃掉城市名
 * ------------------------------------------------------------------ */
check('越秀区中山一路梅花村 → 广州（靠区名）', inferCity('越秀区中山一路梅花村'), {
  city: '广州',
  source: 'district',
});
check('中山一路梅花村（连区名都没写）→ 兜底广州', inferCity('中山一路梅花村'), {
  city: '广州',
  source: 'fallback',
});
check('中山八路 → 兜底广州', inferCity('中山八路'), { city: '广州', source: 'fallback' });
check('广州大道中 → 兜底广州（这是路名，不是「广州」+ 大道）', inferCity('广州大道中'), {
  city: '广州',
  source: 'fallback',
});
check('东莞庄路 → 兜底广州（东莞庄路在天河，别搬去东莞）', inferCity('东莞庄路'), {
  city: '广州',
  source: 'fallback',
});
check('天河区广州大道中 → 广州（靠区名，中段裸城市词不作数）', inferCity('天河区广州大道中'), {
  city: '广州',
  source: 'district',
});

/* ------------------------------------------------------------------ *
 * 二、真城市词不能被误挡：带「市」、跟区名、在串首
 * ------------------------------------------------------------------ */
check('中山市石岐区中山一路 → 中山', inferCity('中山市石岐区中山一路'), {
  city: '中山',
  source: 'explicit',
});
check('广州市越秀区中山一路梅花村130号 → 广州', inferCity('广州市越秀区中山一路梅花村130号'), {
  city: '广州',
  source: 'explicit',
});
check('广州番禺桥南 → 广州', inferCity('广州番禺桥南'), { city: '广州', source: 'explicit' });
check('佛山南海桂城 → 佛山', inferCity('佛山南海桂城'), { city: '佛山', source: 'explicit' });
check('深圳南山区科技园 → 深圳', inferCity('深圳南山区科技园'), { city: '深圳', source: 'explicit' });
check('佛山市南海区桂城街道堑坊村 → 佛山', inferCity('佛山市南海区桂城街道堑坊村'), {
  city: '佛山',
  source: 'explicit',
});
check('广州市番禺区钟村街道诜敦村生态园 → 广州', inferCity('广州市番禺区钟村街道诜敦村生态园'), {
  city: '广州',
  source: 'explicit',
});

/* ------------------------------------------------------------------ *
 * 三、区名单独说话：省略市名的真实写法
 * ------------------------------------------------------------------ */
check('南海桂城 → 佛山', inferCity('南海桂城'), { city: '佛山', source: 'district' });
check('顺德大良 → 佛山', inferCity('顺德大良'), { city: '佛山', source: 'district' });
check('增城区新塘凤凰城 → 广州', inferCity('增城区新塘凤凰城'), { city: '广州', source: 'district' });
check('番禺区大石街道高尔夫路华发越秀·和樾府 → 广州（取最先出现的番禺，不取楼盘名里的越秀）', inferCity('番禺区大石街道高尔夫路华发越秀·和樾府'), {
  city: '广州',
  source: 'district',
});

/* ------------------------------------------------------------------ *
 * 四、兜底与边界
 * ------------------------------------------------------------------ */
check('空地址 → 兜底', inferCity(''), { city: '广州', source: 'fallback' });
check('兜底城市可配置', inferCity('某某路', '佛山'), { city: '佛山', source: 'fallback' });
check('区名优先于兜底', inferCity('天河区某某路', '佛山'), { city: '广州', source: 'district' });

/* ------------------------------------------------------------------ *
 * 五、降级匹配：宁可拒收，也不能拿区几何中心冒充小区
 * ------------------------------------------------------------------ */
check(
  '只到区县 → 拒收',
  isDowngradedMatch({
    address: '天河壹品',
    level: '区县',
    formatted: '广东省广州市天河区',
    fromFallback: false,
  }),
  true,
);
check(
  '落到别的区 → 拒收',
  isDowngradedMatch({
    address: '珠江帝景（海珠区）',
    level: '道路',
    formatted: '广东省广州市黄埔区珠江',
    fromFallback: false,
  }),
  true,
);
check(
  '道路级 + 区名对得上 → 放行（本次修复后该单的目标状态）',
  isDowngradedMatch({
    address: '越秀区中山一路梅花村',
    level: '道路',
    formatted: '广东省广州市越秀区中山一路',
    fromFallback: false,
  }),
  false,
);
check(
  '无城市无区名 + 村庄级 → 拒收',
  isDowngradedMatch({ address: '某某村', level: '村庄', formatted: '', fromFallback: true }),
  true,
);
check(
  '有城市 + 村庄级 → 放行（两三公里范围，拿来排序够用）',
  isDowngradedMatch({
    address: '广州市番禺区诜敦村',
    level: '村庄',
    formatted: '广东省广州市番禺区诜敦村',
    fromFallback: false,
  }),
  false,
);

/* ------------------------------------------------------------------ *
 * 六、POI 名字覆盖率：挡住「搜什么都返回点什么」的噪声
 * ------------------------------------------------------------------ */
check('城投珠江·天河壹品 / 天河壹品 → 0.5', poiNameCoverage('城投珠江·天河壹品', '天河壹品'), 0.5);
check('易通大厦 全字命中 → 1', poiNameCoverage('易通大厦', '广州市天河区黄埔大道易通大厦'), 1);
check('达美乐比萨(锦佳店) / 白云中海金沙湾 → 低于 0.4', poiNameCoverage('达美乐比萨(锦佳店)', '白云中海金沙湾') < 0.4, true);
check('normalizeCity 去掉「市」字', normalizeCity('中山市'), '中山');
check('normalizeCity null 原样返回', normalizeCity(null), null);

console.log(failed === 0 ? `\n全部通过 ✓（${passed} 项）\n` : `\n${failed} 项未通过 ✗（通过 ${passed} 项）\n`);
process.exit(failed === 0 ? 0 : 1);
