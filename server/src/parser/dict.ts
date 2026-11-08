/**
 * 解析字典：所有「靠人肉维护」的知识都放这里，改词不用改代码。
 *
 * 【为什么字典化】不同中介、不同群的模板写法不一致（老师薪水/课时费/待遇）。
 * 如果把这些写法写死进正则，每遇到一个新群就要改代码、要重新测。
 * 抽成字典后，新增一个群通常只加几行数据。
 *
 * 字段别名的来源是 docs/CONTEXT.md 第 3 节的六套真实模板（T1~T6），
 * 每一条都能在原文里找到出处，**不要凭想象加词**。
 */

/** 单子内部字段的规范键 */
export type FieldKey =
  | 'orderNo'
  | 'address'
  | 'region'
  | 'subjects'
  | 'studentInfo'
  | 'grade'
  | 'studentGender'
  | 'currentScore'
  | 'schedule'
  | 'teacherReq'
  | 'salary'
  | 'trialDate'
  | 'infoFee'
  | 'notes';

/**
 * 字段名别名表。
 * 注意：值是规范键，所以「学员情况」「学生情况」「学员年级」都归到同一处再统一归一化。
 */
export const FIELD_ALIASES: Record<string, FieldKey> = {
  // 编号
  家教编号: 'orderNo',
  编号: 'orderNo',
  单号: 'orderNo',
  订单号: 'orderNo',
  订单编号: 'orderNo',
  信息编号: 'orderNo',
  需求编号: 'orderNo',

  // 地址
  学员地址: 'address',
  学生地址: 'address',
  地址: 'address',
  上课地址: 'address',
  上课地点: 'address',
  授课地点: 'address',
  // xc2102 那单写的是「授课地址」：和「授课地点」只差一个字，漏了它整条单就没有地址、
  // 也没有区域（通勤永远算不出），而界面上只显示「地址未识别」—— 看起来像原文没写
  授课地址: 'address',
  辅导地址: 'address', // 广东线下 TFY 群
  辅导地点: 'address', // 同上
  地点: 'address',
  位置: 'address',
  地理位置: 'address',
  住址: 'address',
  区域: 'region',
  片区: 'region',
  商圈: 'region',
  板块: 'region',

  // 科目
  辅导科目: 'subjects',
  补习科目: 'subjects',
  科目: 'subjects',
  学科: 'subjects', // T4
  课程: 'subjects',
  辅导内容: 'subjects',
  教学科目: 'subjects',
  科目要求: 'subjects',
  辅导课程: 'subjects',

  // 学员
  学员情况: 'studentInfo', // T1
  学生情况: 'studentInfo',
  学员信息: 'studentInfo',
  学生信息: 'studentInfo',
  孩子情况: 'studentInfo',
  学员: 'studentInfo', // T4
  学生: 'studentInfo',
  情况: 'studentInfo', // T2
  学情: 'notes', // T4：讲的是学习现状，不是年级，别混进年级解析
  学员年级: 'grade',
  学生年级: 'grade', // T3
  年级: 'grade', // T2 / T5
  // 「年级科目」这类把年级和科目写在一个字段里的：归到 grade（学段靠它判），
  // 科目本身整段文本都能扫到，不会丢
  年级科目: 'grade',
  年级学科: 'grade',
  // 「【年级及科目】：初二，全科，课内」—— 也归 grade：学段只能从这一段里读出来，
  // 科目另有「扫全文」兜底（见 buildOrder 里 subjectText 为空时 detectSubjects(all)）
  年级及科目: 'grade',
  年级及学科: 'grade',
  学生性别: 'studentGender', // T3
  性别: 'studentGender',
  现阶段成绩: 'currentScore', // T3（值常常是空的）
  现有成绩: 'currentScore',
  目前成绩: 'currentScore',

  // 时间
  时间安排: 'schedule',
  补习时间: 'schedule', // T3
  上课时间: 'schedule',
  上课次数: 'schedule', // T1
  时间: 'schedule', // T2 / T4 / T5
  排课: 'schedule',
  课时安排: 'schedule',
  授课时间: 'schedule',
  上课频次: 'schedule',
  时间次数: 'schedule', // 广东线下 TFY 群

  // 老师要求
  对老师要求: 'teacherReq', // T3
  教员要求: 'teacherReq', // T6
  老师要求: 'teacherReq', // T1
  教师要求: 'teacherReq',
  教员条件: 'teacherReq',
  老师条件: 'teacherReq',
  老师: 'teacherReq', // T5 的 `【老师】大学生#985/211`
  要求: 'teacherReq', // T2 / T4 / T5

  // 薪水
  老师薪水: 'salary', // T6
  老师薪资: 'salary', // T1
  薪水: 'salary',
  薪资: 'salary', // T5
  课时费: 'salary',
  课酬: 'salary',
  课时: 'salary', // `【课时】:70-80/h`（gz 群）
  课时报酬: 'salary', // 广东线下 TFY 群
  课费报酬: 'salary', // 同上
  薪酬: 'salary', // T4
  薪酬待遇: 'salary',
  待遇: 'salary',
  费用: 'salary',
  工资: 'salary',
  报酬: 'salary', // T2
  价格: 'salary',
  报价: 'salary', // T3

  // 附加信息
  试课日期: 'trialDate', // T4
  信息费: 'infoFee', // T4
  备注: 'notes',
  其他: 'notes',
  补充: 'notes',
  说明: 'notes',
  补充说明: 'notes',
};

/**
 * 区/县级地名。用于从地址里反推行政区，做「按区筛选」。
 * 需要扩展到其他城市时，直接往这里加。
 */
export const DISTRICTS = [
  '越秀', '荔湾', '海珠', '天河', '白云', '黄埔',
  '番禺', '花都', '南沙', '从化', '增城',
  '南海', '顺德', '禅城', '三水', '高明',
];

/** 城市名：独立成行的「广州市」之类没有信息量，但地址里出现要能跳过 */
export const CITIES = ['广州', '佛山', '深圳', '东莞', '中山', '珠海', '惠州'];

/** 商圈/街道级后缀词，用来从地址里截出「大石街道」「桥南」这种小地名 */
export const AREA_SUFFIXES = [
  '街道', '镇', '街', '大道', '路', '村', '地铁站', '广场', '花园', '小区', '苑', '城',
];

/** 主学科表：按优先级排列，命中即在结果里按此顺序输出 */
export const SUBJECT_MAIN: { name: string; keywords: string[] }[] = [
  {
    name: '英语',
    keywords: [
      '英语', '英文', 'english', '全英', '剑桥', 'think', '新概念', 'ket', 'pet', 'fce',
      '雅思', '托福', 'ielts', 'toefl', '自然拼读', 'phonics', '口语', 'unlock',
      'reading explorer', 'great writing', '牛津', '外教', '双语',
    ],
  },
  {
    name: '数学',
    keywords: ['数学', '奥数', '思维训练', '举一反三', 'amc', '袋鼠', '口算', 'calculus', '代数', '几何'],
  },
  {
    name: '语文',
    keywords: ['语文', '阅读写作', '作文', '文言文', '古诗文', '大语文', '拼音', '识字', '阅读理解'],
  },
  { name: '物理', keywords: ['物理'] },
  { name: '化学', keywords: ['化学'] },
  { name: '生物', keywords: ['生物'] },
  { name: '科学', keywords: ['科学', 'science'] },
  { name: '政治', keywords: ['政治', '道法', '道德与法治'] },
  { name: '历史', keywords: ['历史'] },
  { name: '地理', keywords: ['地理'] },
  { name: '编程', keywords: ['编程', 'scratch', 'python', 'c++', '信息学', '信奥', '机器人'] },
  {
    name: '音乐',
    keywords: ['钢琴', '小提琴', '古筝', '古琴', '吉他', '声乐', '乐理', '考级', '音乐', '电子琴', '架子鼓', '空灵鼓'],
  },
  { name: '美术', keywords: ['美术', '画画', '素描', '水彩', '国画', '书法', '硬笔'] },
  {
    name: '体育',
    keywords: ['羽毛球', '篮球', '足球', '游泳', '网球', '乒乓球', '跳绳', '体能', '田径'],
  },
  { name: '小语种', keywords: ['日语', '法语', '德语', '西班牙语', '韩语', '俄语'] },
  // 「全科」不是一门学科，但它回答了「补什么」这个问题；不认的话这种单会顶一条
  // 「未识别到科目」，而原文其实写得很清楚（`初二，全科，课内`）
  { name: '全科', keywords: ['全科'] },
];

/**
 * 连写简称：`物化生`、`数理化`、`语数英`。
 * 群里几乎每张单都会这么写，而按关键字扫不出来（`物化生` 这三个字里没有「物理」）。
 * 长的写在前面，避免 `语数英` 被 `语数` 先吃掉。
 */
export const SUBJECT_ABBR: { pattern: RegExp; names: string[] }[] = [
  { pattern: /物化生/, names: ['物理', '化学', '生物'] },
  { pattern: /数理化/, names: ['数学', '物理', '化学'] },
  { pattern: /语数英/, names: ['语文', '数学', '英语'] },
  { pattern: /政史地/, names: ['政治', '历史', '地理'] },
  { pattern: /语数(?!英)/, names: ['语文', '数学'] },
];

/** 细分标签：比主学科更具体的卖点/要求，用于二次筛选 */
export const SUBJECT_TAGS: { tag: string; keywords: string[] }[] = [
  { tag: '剑桥Think', keywords: ['剑桥', 'think'] },
  { tag: '新概念', keywords: ['新概念'] },
  { tag: '剑桥考级', keywords: ['ket', 'pet', 'fce', '考级'] },
  { tag: '雅思托福', keywords: ['雅思', '托福', 'ielts', 'toefl'] },
  { tag: '自然拼读', keywords: ['自然拼读', 'phonics', '拼读'] },
  { tag: '启蒙', keywords: ['启蒙'] },
  { tag: '全英授课', keywords: ['全英', '全英语', '纯英文', '英文授课'] },
  { tag: '口语对话', keywords: ['口语', '对话'] },
  { tag: '阅读', keywords: ['阅读', 'reading'] },
  { tag: '写作', keywords: ['写作', 'writing'] },
  { tag: '奥数', keywords: ['奥数', '思维训练'] },
  { tag: '新加坡数学', keywords: ['新加坡数学', 'singapore'] },
  { tag: 'AMC', keywords: ['amc', '袋鼠'] },
  { tag: '作文', keywords: ['作文'] },
  { tag: '文言文', keywords: ['文言文', '古诗文'] },
  { tag: '拼音识字', keywords: ['拼音', '识字'] },
  { tag: '编程', keywords: ['编程', 'scratch', 'python', 'c++', '信息学'] },
  { tag: '钢琴', keywords: ['钢琴'] },
  { tag: '书法', keywords: ['书法', '硬笔'] },
  { tag: '作业辅导', keywords: ['作业辅导', '作业'] }, // T5 #1044
  { tag: 'DSE课程', keywords: ['dse'] }, // T5 #1138
  { tag: '跳绳', keywords: ['跳绳'] }, // T1 ZX2202
  { tag: '需持证', keywords: ['教师资格证', '教资', '持证'] },
];

/** 中文数字 → 阿拉伯数字（只处理 1~10 的常见写法） */
export const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
