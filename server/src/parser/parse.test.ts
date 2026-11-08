/**
 * 六套真实模板回归测试。
 *
 * 样本文件在 ./samples/ 下，逐字取自 docs/CONTEXT.md 第 3 节 —— 那是整个项目
 * 最珍贵的资产，解析规则全部由它们反推。**改动 dict.ts / parse.ts 必须重跑本测试。**
 *
 * 运行：npm -w server run test（Node 24 直接执行 TS，不装依赖也能跑）
 */
import { readFileSync } from 'node:fs';
import { parseMessage, type ParsedOrder } from './parse.ts';

const load = (name: string) => readFileSync(new URL(`./samples/${name}.txt`, import.meta.url), 'utf8');

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

function section(title: string) {
  console.log(`\n${title}`);
}

function orders(title: string, file: string, expectCount: number): ParsedOrder[] {
  const list = parseMessage(load(file));
  section(`${title}（${list.length} 单，期望 ${expectCount}）`);
  check(`${title} 单子数量`, list.length, expectCount);
  return list;
}

/* ---------------------------------------------------------------- *
 * T1 · 广州家教群YF11群 —— 城市词冒号锚点 + 中文标签
 * ---------------------------------------------------------------- */
{
  const [a, b] = orders('T1', 't1', 2);
  if (a) {
    check('T1.1 编号', a.orderNo, 'ZX2201');
    check('T1.1 状态标记没混进编号', a.statusTag, '新单');
    check('T1.1 区', a.district, '海珠区');
    check('T1.1 商圈', a.area, '昌岗');
    check('T1.1 学段', a.stage, '小学');
    check('T1.1 年级', a.gradeNum, 2);
    check('T1.1 学生性别', a.studentGender, '女');
    check('T1.1 科目', a.subjects, ['数学']);
    check('T1.1 奥数标签', a.subjectTags.includes('奥数'), true);
    check('T1.1 频次（安排一次）', a.freqPerWeek, 1);
    check('T1.1 单次时长（一次1-1.5h 取下限）', a.hoursPerSession, 1);
    check('T1.1 薪水下限', a.salaryMin, 100);
    check('T1.1 薪水上限', a.salaryMax, 120);
    check('T1.1 时薪', a.salaryHourly, 100);
    check('T1.1 置信度', a.confidence, 'high');
    check('T1.1 原文含锚点行', a.rawText.startsWith('广州线下: ZX2201#新单'), true);
  }
  if (b) {
    check('T1.2 编号', b.orderNo, 'ZX2202');
    check('T1.2 区', b.district, '荔湾区');
    check('T1.2 商圈', b.area, '芳村');
    check('T1.2 科目（跳绳→体育）', b.subjects, ['体育']);
    check('T1.2 跳绳标签', b.subjectTags.includes('跳绳'), true);
    check('T1.2 人数不明不猜', b.studentCount, null);
    check('T1.2 单次时长（7.30-8.30）', b.hoursPerSession, 1);
    check('T1.2 时薪', b.salaryHourly, 100);
  }
}

/* ---------------------------------------------------------------- *
 * T2 · YF11群 —— emoji 锚点 + 『』包裹
 * ---------------------------------------------------------------- */
{
  const [a, b] = orders('T2', 't2', 2);
  if (a) {
    check('T2.1 编号', a.orderNo, 'susu2610501');
    check('T2.1 区', a.district, '白云区');
    check('T2.1 学段', a.stage, '初中');
    check('T2.1 年级', a.gradeNum, 3);
    check('T2.1 学生性别（年级行里的「男孩」）', a.studentGender, '男');
    check('T2.1 科目', a.subjects, ['化学']);
    check('T2.1 频次（每周六）', a.freqPerWeek, 1);
    check('T2.1 单次时长（每节课两小时）', a.hoursPerSession, 2);
    check('T2.1 时薪', a.salaryHourly, 100);
    check('T2.1 块内不含话题噪声', a.rawText.includes('带相关证书投递'), false);
  }
  if (b) {
    check('T2.2 编号', b.orderNo, 'susu26102701');
    check('T2.2 学段', b.stage, '高中');
    check('T2.2 科目', b.subjects, ['英语']);
    check('T2.2 缺薪水留空', b.salaryRaw, null);
    check('T2.2 缺薪水已标记', b.warnings.includes('未识别到薪水'), true);
    check('T2.2 置信度降级', b.confidence, 'medium');
  }
}

/* ---------------------------------------------------------------- *
 * T3 · 某家教群 —— 数字编号锚点 + 【】包裹
 * ---------------------------------------------------------------- */
{
  const [a, b, c] = orders('T3', 't3', 3);
  if (a) {
    check('T3.1 编号', a.orderNo, '110512');
    check('T3.1 区', a.district, '海珠区');
    check('T3.1 学段', a.stage, '小学');
    check('T3.1 年级', a.gradeNum, 6);
    check('T3.1 学生性别', a.studentGender, '女');
    check('T3.1 科目', a.subjects, ['数学']);
    check('T3.1 频次', a.freqPerWeek, 1);
    check('T3.1 单次时长', a.hoursPerSession, 2);
    check('T3.1 薪水（100每小时）', a.salaryMin, 100);
    check('T3.1 单位', a.salaryUnit, 'hour');
    check('T3.1 空值字段不误判', a.confidence, 'high');
    check('T3.1 老师要求里的 985 原样保留', a.teacherReq?.includes('985'), true);
  }
  if (b) {
    check('T3.2 编号', b.orderNo, '110513');
    check('T3.2 学段', b.stage, '初中');
    check('T3.2 科目', b.subjects, ['物理']);
    check('T3.2 时薪', b.salaryHourly, 100);
    check('T3.2 竹料不在区名词典→留空不猜', b.district, null);
    check('T3.2 缺区域已标记', b.warnings.includes('未识别到区域'), true);
  }
  if (c) {
    check('T3.3 编号', c.orderNo, '110514');
    check('T3.3 学段', c.stage, '高中');
    check('T3.3 缺地址不当成字符串猜', c.district, null);
    check('T3.3 时薪', c.salaryHourly, 120);
    check('T3.3 置信度', c.confidence, 'medium');
  }
}

/* ---------------------------------------------------------------- *
 * T4 · 广州众行家教群 —— 字母数字编号 + 分档薪酬
 * ---------------------------------------------------------------- */
{
  const [a, b, c] = orders('T4', 't4', 3);
  if (a) {
    check('T4.1 编号', a.orderNo, 'ZXGZ20261103.2');
    check('T4.1 区', a.district, '海珠区');
    check('T4.1 学段（学员行里的「初一」）', a.stage, '初中');
    check('T4.1 年级', a.gradeNum, 1);
    check('T4.1 性别不在「要求」里误扫', a.studentGender, '女');
    check('T4.1 科目', a.subjects, ['英语']);
    check('T4.1 分档数量', a.salaryTiers.length, 2);
    check('T4.1 第一档标签', a.salaryTiers[0]?.label, '一本');
    check('T4.1 第二档标签', a.salaryTiers[1]?.label, '92/研究生');
    check('T4.1 第二档区间', [a.salaryTiers[1]?.min, a.salaryTiers[1]?.max], [110, 120]);
    check('T4.1 标量取最低档', [a.salaryMin, a.salaryMax], [100, 100]);
    check('T4.1 时薪', a.salaryHourly, 100);
    check('T4.1 频次（一周一次）', a.freqPerWeek, 1);
    check('T4.1 单次时长（9-11点）', a.hoursPerSession, 2);
  }
  if (b) {
    check('T4.2 编号（# 被归一）', b.orderNo, 'ZXGZ20261103.3');
    check('T4.2 区', b.district, '天河区');
    check('T4.2 年级', b.gradeNum, 2);
    check('T4.2 学生性别', b.studentGender, '男');
    check('T4.2 时薪下限', b.salaryHourly, 220);
    check('T4.2 时薪上限', b.salaryMax, 240);
  }
  if (c) {
    check('T4.3 编号', c.orderNo, 'ZXGZ20261104.1');
    check('T4.3 学段', c.stage, '高中');
    check('T4.3 科目', c.subjects, ['数学']);
    check('T4.3 单次时长（上课2小时）', c.hoursPerSession, 2);
    check('T4.3 分档取最低档', c.salaryMin, 120);
    check('T4.3 时薪', c.salaryHourly, 120);
  }
}

/* ---------------------------------------------------------------- *
 * T5 · 住家教073 —— #编号 + 【】无冒号 + 公告块 + 时间头
 * ---------------------------------------------------------------- */
{
  const list = orders('T5', 't5', 4);
  check('T5 全部拿到消息发送时间', list.map((o) => o.sentAt), Array(4).fill('2026-11-05T14:58:00'));
  check(
    'T5 公告块没被吞进任何单子',
    list.some((o) => /信息费收取标准|上门家教073|试课收费规则/.test(o.rawText)),
    false,
  );

  const [a, b, c, d] = list;
  if (a) {
    check('T5.1 编号', a.orderNo, '1138');
    check('T5.1 区', a.district, '天河区');
    check('T5.1 学段', a.stage, '高中');
    check('T5.1 学生数（双胞胎）', a.studentCount, 2);
    check('T5.1 科目', a.subjects, ['数学']);
    check('T5.1 DSE标签', a.subjectTags.includes('DSE课程'), true);
    check('T5.1 频次', a.freqPerWeek, 1);
    check('T5.1 单次时长（一次2h）', a.hoursPerSession, 2);
    check('T5.1 时薪', a.salaryHourly, 150);
  }
  if (b) {
    check('T5.2 编号', b.orderNo, '1143');
    check('T5.2 区', b.district, '白云区');
    check('T5.2 学段', b.stage, '高中');
    check('T5.2 年级', b.gradeNum, 3);
    check('T5.2 科目', b.subjects, ['地理']);
    check('T5.2 时薪下限', b.salaryHourly, 260);
    check('T5.2 要求里的专职老师原样保留', b.teacherReq, '专职老师');
  }
  if (c) {
    check('T5.3 编号', c.orderNo, '1044');
    check('T5.3 区', c.district, '增城区');
    check('T5.3 学段', c.stage, '小学');
    check('T5.3 年级（1-3年级取下限）', c.gradeNum, 1);
    check('T5.3 科目', c.subjects, ['英语']);
    check('T5.3 作业辅导标签', c.subjectTags.includes('作业辅导'), true);
    check('T5.3 频次', c.freqPerWeek, 6);
    check('T5.3 单次时长', c.hoursPerSession, 2);
    check('T5.3 时薪', c.salaryHourly, 75);
  }
  if (d) {
    check('T5.4 编号', d.orderNo, '1045');
    check('T5.4 区', d.district, '番禺区');
    check('T5.4 科目（猎德是地名）', d.subjects, ['英语']);
    check('T5.4 时薪', d.salaryHourly, 110);
    check('T5.4 截断被识别（缺要求）', d.warnings.includes('缺少老师要求'), true);
    check('T5.4 置信度降级', d.confidence, 'medium');
  }
}

/* ---------------------------------------------------------------- *
 * T6 · 老格式 —— 家教编号: 冒号字段
 * ---------------------------------------------------------------- */
{
  const [a, b, c, d] = orders('T6', 't6', 4);
  if (a) {
    check('T6.1 编号', a.orderNo, '2026101803');
    check('T6.1 区', a.district, '番禺区');
    check('T6.1 商圈', a.area, '桥南');
    check('T6.1 学段', a.stage, '小学');
    check('T6.1 年级', a.gradeNum, 4);
    check('T6.1 科目', a.subjects, ['英语']);
    check('T6.1 剑桥标签', a.subjectTags.includes('剑桥Think'), true);
    check('T6.1 形式', a.mode, '上门');
    check('T6.1 时薪', a.salaryHourly, 130);
    check('T6.1 置信度', a.confidence, 'high');
  }
  if (b) {
    check('T6.2 编号', b.orderNo, '2026102902');
    check('T6.2 商圈', b.area, '大石街道');
    check('T6.2 学段', b.stage, '幼儿');
    check('T6.2 学生数', b.studentCount, 2);
    check('T6.2 学生性别', b.studentGender, '女');
    check('T6.2 频次', b.freqPerWeek, 6);
    check('T6.2 单次时长（19:00-21:30）', b.hoursPerSession, 2.5);
    check('T6.2 单位', b.salaryUnit, 'month');
    check('T6.2 折算时薪', b.salaryHourly, 46.2);
  }
  if (c) {
    check('T6.3 编号（尾部 # 剥掉）', c.orderNo, '202601002');
    check('T6.3 区（靠前置地名行归类）', c.district, '南沙区');
    check('T6.3 年级', c.gradeNum, 1);
    check('T6.3 区间下限', c.salaryMin, 70);
    check('T6.3 区间上限', c.salaryMax, 100);
    check('T6.3 时薪取下限', c.salaryHourly, 70);
  }
  if (d) {
    check('T6.4 编号', d.orderNo, '2026092902');
    check('T6.4 商圈', d.area, '蕉门地铁站');
    check('T6.4 科目', d.subjects, ['英语', '数学']);
    check('T6.4 原薪文字保留', d.salaryRaw, '80三次');
    check('T6.4 单位识别不出→不折算', d.salaryHourly, null);
    check('T6.4 置信度降级', d.confidence, 'medium');
  }
}

/* ---------------------------------------------------------------- *
 * 现场回归（2026-11-06）：微信里实际粘进来、六套模板没覆盖的两种写法
 * ---------------------------------------------------------------- */
{
  section('[7] 编号行带备注 / 按次报价 / DSE 科目');

  const raw = `ZXGZ20261104.1
【地址】：白云十四号线夏良
【学科】：数学
【学员】：高二
【学情】：基础中等
【要求】:一本/982/211大学生，理科专业优先，数学家教经验丰富，有方法有能力
【时间】：周六下午上课2小时
【薪酬】：一本120/小时，92/研究生130/小时
【试课日期】：协商
ZXGZ20261104.2  机构单618
【地址】：广州白云区XX花园
【学科】：全科
【学员】：小学
【学情】：基础中等
【薪酬】：一节课150（1.5小时)`;

  const list = parseMessage(raw);
  // 原来「编号 + 两个空格 + 机构单618」匹配不上锚点，第二单的字段被并进第一单
  check('编号行带备注也要切成两单', list.length, 2);
  check('第 1 单地址没被第 2 单覆盖', list[0]?.address, '白云十四号线夏良');
  check(
    '第 1 单的要求没缝进第 2 单的句子',
    list[0]?.teacherReq,
    '一本/982/211大学生，理科专业优先，数学家教经验丰富，有方法有能力',
  );
  check('第 1 单时薪', list[0]?.salaryHourly, 120);
  check('第 2 单编号', list[1]?.orderNo, 'ZXGZ20261104.2');
  check('编号行尾的备注进 statusTag', list[1]?.statusTag, '机构单618');
  check('第 2 单地址', list[1]?.address, '广州白云区XX花园');
  // 价格是 150，括号里的 1.5 小时是时长：折算完应当是 100 元/小时，不是 1.5
  check('按次报价不当成 1.5 元/小时', [list[1]?.salaryUnit, list[1]?.salaryHourly], ['session', 100]);

  const dse = parseMessage(`广州线下：ZX2208#新单
学员地址：南沙东涌地铁站
辅导科目：DSE物理
学员情况：中五男
老师要求：中大华工研究生，耐心负责，或物理专业本科生，英语好，教材是全英教材
老师薪资：300-360/2h`);
  check('DSE物理 → 科目是物理', dse[0]?.subjects, ['物理']);
  check('DSE 进标签', dse[0]?.subjectTags.includes('DSE课程'), true);
  check('全角冒号同样能读字段', dse[0]?.address, '南沙东涌地铁站');
  check('「300-360/2h」换算成时薪 150', [dse[0]?.salaryUnit, dse[0]?.salaryHourly], ['session', 150]);
  check('「300-360/2h」保留区间', [dse[0]?.salaryMin, dse[0]?.salaryMax], [300, 360]);
}

/* ---------------------------------------------------------------- *
 * 「总价 / 单次时长」写法：120/2小时、200-240/2h
 *
 * 这两种写法原来会得到两种都错的答案：`/2小时` 被读成「2 元/小时」（看着正常、
 * 实际排序垫底），`/2h` 里的 h 认不出单位、时薪直接留空。
 * ---------------------------------------------------------------- */
{
  section('[7.5] 总价/时长：斜杠后面是时长，不是价格');

  // 卡片上就是这么显示成「2 元/小时」的那一单
  const [a] = parseMessage(`家教编号: 2026110701
学员地址: 天河天府路隽悦园
辅导科目: 英语
时间安排: 每周一到周五的晚上6.30-8.30
老师薪水: 120/2小时`);
  check('「120/2小时」不是 2 元/小时', [a?.salaryUnit, a?.salaryMin, a?.salaryHourly], ['session', 120, 60]);

  // 时间字段常写「具体时间协商」，时长只能从报价里取
  const [b] = parseMessage(`家教编号: 2026110702
学员地址: 番禺汉溪长隆
辅导科目: 数学
时间安排: 具体时间协商
老师薪水: 200-240/2h`);
  check('时间没写时长时，从报价里的 /2h 补', [b?.salaryUnit, b?.salaryHourly], ['session', 100]);

  const [c] = parseMessage(`家教编号: 2026110703
学员地址: 花都清布地铁站
辅导科目: 英语
时间安排: 具体时间协商
老师薪水: 120-135/1.5h`);
  check('「120-135/1.5h」取区间下限折算', [c?.salaryMin, c?.salaryMax, c?.salaryHourly], [120, 135, 80]);

  // 纯时薪写法不能被新规则吞掉
  const [d] = parseMessage(`家教编号: 2026110704
学员地址: 天河岗顶
辅导科目: 英语
时间安排: 每周1次
老师薪水: 100-120/h`);
  check('「100-120/h」仍是时薪', [d?.salaryUnit, d?.salaryHourly], ['hour', 100]);
}

/* ---------------------------------------------------------------- *
 * 真实现场样本（2026-11-06 一次粘贴 458 行、十几个群的写法混在一起）
 *
 * 这段文本原来整段只切出 1 个单子 —— 因为锚点池只认得出「整行只有编号」那几种写法，
 * 其余的编号行都被当成上一单的续行，字段互相覆盖。现在锚点按「洗掉装饰符再匹配」处理。
 * ---------------------------------------------------------------- */
{
  section('[8] 现场大杂烩样本');
  const list = parseMessage(load('real-20261106'));
  const pick = (no: string) => list.filter((o) => o.orderNo === no);

  // 快照断言：切块规则一改这里就会响，提醒你回去看是不是把某群切坏了
  check('切成 50 块（原来整段只有 1 块）', list.length, 50);

  check('ZX2208 是两张不同的单', pick('ZX2208').map((o) => o.address), ['南沙东涌地铁站', '天河五山东莞庄']);
  check('编号行尾备注 → statusTag', pick('ZXGZ20261104.2')[0]?.statusTag, '机构单618');
  check('ZXGZ20261104.1 地址没被 .2 覆盖', pick('ZXGZ20261104.1')[0]?.address, '白云十四号线夏良');

  // 广东线下 TFY 群：`广东线下TFY🌧️26110602＃新单`
  const tfy = pick('TFY26110602')[0];
  check('emoji 夹在编号中间也能认出', tfy?.anchorKind, 'cityLabel');
  check('【辅导地址】读得到', tfy?.address, '海珠区客村地铁站附近');
  check('「物化生」展开成三门课', tfy?.subjects, ['物理', '化学', '生物']);
  check('【课时报酬】读得到', tfy?.salaryHourly, 130);

  // 广州 110208 这种「城市词 + 纯数字」
  check('城市词 + 纯数字也认', pick('110208')[0]?.anchorKind, 'cityLabel');
  // 【家教编号】gz31511106 这种带方括号的
  check('方括号编号也认', pick('gz31511106')[0]?.anchorKind, 'labelId');
  // LL11.5回收（梧桐）
  check('字母 + 两位数字 + 点号也认', pick('LL11.5').length, 1);
  // 200--300/h 连着两个减号
  check('双横线区间取下限', [pick('GZ506306389')[0]?.salaryMin, pick('GZ506306389')[0]?.salaryMax], [200, 300]);
  // 【辅导地址】】#… 前面多一个右括号和一个 #
  check('地址前的 】# 被剥掉', pick('TFY2510106')[0]?.address, '天河区沙河街道XX路XX号');
}

/* ---------------------------------------------------------------- *
 * 线上单：地址栏里写的「线上」不是地址，是授课形式
 * ---------------------------------------------------------------- */
{
  section('[9] 地址只写「线上」→ 线上授课，不留地址、不算通勤');

  const [a] = parseMessage(`家教编号: 2026110613
学员地址: 线上
辅导科目: 英语
时间安排: 每周1次
教员要求: 男女不限
老师薪水: 150元/h`);
  check('地址留空（绝不拿「线上」去地理编码）', a?.address, null);
  check('形式识别为线上', a?.mode, '线上');
  check('不因「缺区域」降置信度', a?.confidence, 'high');
  check('线索记在 warnings 之外：区域确实没有，但不该因此怀疑整单', a?.warnings.includes('未识别到区域'), false);

  const [b] = parseMessage(`家教编号: 2026110614
学员地址: 网课
辅导科目: 数学
时间安排: 每周1次
教员要求: 男女不限
老师薪水: 120元/h`);
  check('「网课」同样当成线上', [b?.address, b?.mode], [null, '线上']);

  const [c] = parseMessage(`家教编号: 2026110615
学员地址: 天河区线上城小区
辅导科目: 数学
时间安排: 每周1次
教员要求: 男女不限
老师薪水: 120元/h`);
  check('地名里带「线上」二字的不算线上单（否则会静默漏算通勤）', [c?.address, c?.mode], ['天河区线上城小区', null]);

  const [d] = parseMessage(`家教编号: 2026110616
学员地址: 番禺桥南
辅导科目: 英语
时间安排: 每周1次
教员要求: 男女不限
老师薪水: 120元/h
备注: #线上 也可以，家长接受网课`);
  check('#线上 这种独立写法仍能认出', d?.mode, '线上');
  check('但真地址要留着（混合单）', d?.address, '番禺桥南');
}

console.log(
  failed === 0 ? `\n全部通过 ✓（${passed} 项）\n` : `\n${failed} 项未通过 ✗（通过 ${passed} 项）\n`,
);
process.exit(failed === 0 ? 0 : 1);
