import { isMediaToolId } from '../../../../server/src/analytics/registry.ts';
import { toolOrder, type ToolId, type ToolsState } from './tools-state.ts';

export type ToolFilter = 'all' | 'frequent' | 'media';

export interface ToolGuideInfo {
  title: string;
  term?: string;
  description: string;
  color: string;
  start: string;
  examples: readonly [string, string, string];
  keywords?: string;
}

export const toolsCatalog: Record<ToolId, ToolGuideInfo> = {
  news: {
    title: 'AI 新闻', term: 'AI 情报', description: '看 AI 新工具、产品更新和行业动态', color: 'text-violet-500',
    start: '打开后可以选感兴趣的新闻阅读。登录后可关注常看的来源。',
    examples: ['听说某个 AI 应用更新了，看看这次加了什么。', '想找能帮忙写文案或做图片的新工具，浏览最近的产品新闻。', '通勤时翻一翻最近的 AI 大事。'],
  },
  calendar: {
    title: '查日期和节日', term: '万年历', description: '查公历、农历、节气和放假调休', color: 'text-amber-500',
    start: '先切到想查的月份，再点某一天看详细日期和节日。',
    examples: ['看看今年中秋节是星期几。', '安排出游前查假期哪天休息、哪天要补班。', '把家人的公历生日对照成当年的农历日期。'],
    keywords: '日历 阴历 假期',
  },
  weather: {
    title: '查天气', description: '看今天会不会下雨，也能查其他城市', color: 'text-sky-500',
    start: '页面会根据网络估计你所在的地区。显示错了，可以输入实际的城市或区县。',
    examples: ['早上出门前看今天要不要带伞。', '收拾行李时查目的地的温度，决定带短袖还是外套。', '打算周末去公园，先看看哪天更适合出门。'],
    keywords: '天气预报 看天气',
  },
  greeting: {
    title: '找句问候语', term: '随机问候语', description: '按时间、节日或天气换一句问候', color: 'text-emerald-500',
    start: '点「换一句」看看其他说法，挑一句合适的发给朋友或家人。',
    examples: ['早上在家人群里发一句早安。', '节日想给朋友发祝福，先找一句顺口的。', '天气变冷时，找一句提醒家人添衣的话。'],
  },
  timestamp: {
    title: '时间和数字互转', term: '时间戳与时区', description: '把一串时间数字变成日期，或查看同一时刻在各地的时间', color: 'text-sky-500',
    start: '时间戳是一串用来记录时刻的数字。粘贴数字时，常见的 10 位选「秒」，13 位选「毫秒」。',
    examples: ['导出的订单时间是一长串数字，转成能看懂的日期。', '收到带时差的会议时间，看看在北京时间是几点。', '软件客服问某串数字对应哪一天，查出来再回复。'],
    keywords: '日期转换 unix 时间差 北京时间 ISO UTC',
  },
  json: {
    title: '整理数据文本', term: 'JSON 格式化', description: '给挤在一行的数据分行排好，也能检查写法有没有错', color: 'text-violet-500',
    start: 'JSON 是软件用来保存数据的一种文字格式。粘贴带花括号或方括号的数据，再点「分行排好」。',
    examples: ['打开软件导出的设置，发现内容全挤在一行，排好后再看。', '复制配置到另一个工具时报错，检查是不是少了引号或逗号。', '提交一段数据时表单只收一行，把多行合成一行再粘贴。'],
    keywords: '美化 压缩 校验 配置 pretty print',
  },
  qr: {
    title: '把链接做成二维码', term: '二维码生成', description: '用一段文字或网址做个码，别人扫一扫就能打开', color: 'text-emerald-500',
    start: '粘贴网址或文字，在预览里确认二维码，再下载。',
    examples: ['把聚会报名链接做成二维码，印在活动通知上。', '给一张传单加个地图链接，别人扫码就能导航。', '把一小段联系方式做成二维码，放在摊位牌上。'],
    keywords: '扫码 网站 QR QRCode',
  },
  diff: {
    title: '找出两段文字的不同', term: '文本对比', description: '贴上两份内容，标出哪里多了、哪里少了', color: 'text-amber-500',
    start: '把修改前和修改后的内容分别粘贴到两个框里，再点「找出不同」。',
    examples: ['群里发了两版活动通知，看看改的是不是时间。', '改过简历后，对照检查哪些句子被删掉了。', '比较两份商品说明，找出新增的注意事项。'],
    keywords: '差异 diff 比较 对照',
  },
  pomodoro: {
    title: '专注计时', term: '番茄钟', description: '定一段专注时间，到点记得休息', color: 'text-rose-500',
    start: '先设专注和休息各多少分钟，再点开始。关闭页面后，页面内提醒也会关闭。',
    examples: ['写作业先专心 25 分钟，再起来休息 5 分钟。', '上班想集中处理一封长邮件，给自己定一段免打扰时间。', '读书总忍不住看手机，先设一个短计时试试。'],
  },
  units: {
    title: '换算斤、厘米等单位', term: '单位换算', description: '重量、尺寸、容量和温度可以互相换算', color: 'text-sky-500',
    start: '先选要换算的类型，填数字，再选手里的单位和想换成的单位。',
    examples: ['菜谱写 500 克，看看等于几斤。', '买家具前把英寸换成厘米，确认尺寸放得下。', '国外天气写华氏度，换成摄氏度再决定穿什么。'],
    keywords: '长度 面积 体积 cm kg oz',
  },
  dates: {
    title: '算还差几天', term: '日期助手', description: '算两天隔多久、往前往后是哪天，也能算周岁', color: 'text-violet-500',
    start: '先选「算相隔几天」「算几天前后」或「算周岁」，再选日期。',
    examples: ['离旅行出发还有几天？', '试用期从今天算 30 天，到哪一天？', '给孩子填报名表，算一算到指定那天满几周岁。'],
    keywords: '日期计算 倒计时 倒数日 生日 年龄',
  },
  shopping: {
    title: '买东西算哪种更划算', term: '购物计算', description: '比较大小包装的价格，算打折、减券或满减', color: 'text-emerald-500',
    start: '比较包装时，两件商品的数量都用同一种单位，比如都填克。',
    examples: ['两瓶洗衣液容量不一样，算同样多哪瓶更便宜。', '衣服打八五折，还能用一张 20 元券，算最后付多少。', '购物车要满 99 减 10，算差多少钱和凑单值不值。'],
    keywords: '比价 打折 优惠券 满减 凑单',
  },
  random: {
    title: '抽签和分组', term: '随机选择', description: '决定今天吃什么、抽几位中奖者，或把一群人分组', color: 'text-amber-500',
    start: '把人名或选项放进去，一行写一个，再选是抽签还是分组。',
    examples: ['几个人都决定不了吃什么，把餐厅名单放进去抽一个。', '聚会做小抽奖，从名单里抽三个人。', '课堂或团建临时分队，把成员随机分成几组。'],
  },
  'image-edit': {
    title: '裁照片、改大小', term: '图片编辑', description: '改尺寸、转正照片、缩小文件或换图片格式', color: 'text-sky-500',
    start: '选一张照片，边调边看。生成后会显示实际文件大小。',
    examples: ['报名网站只收 2 MB 以内的照片，把文件调小再交。', '从合照裁出一张方头像。', '把横倒的照片转正，或转成表单要求的 JPG。'],
    keywords: '压缩照片 压缩图片 照片太大 裁切 旋转 webp png jpg 像素',
  },
  'image-stitch': {
    title: '把几张图拼成一张', term: '长图拼接', description: '把截图或照片竖着拼、并排放，或者排成几行', color: 'text-violet-500',
    start: '可以一次选择几张图。用上下箭头调顺序，再挑一种排列方式。',
    examples: ['把几张聊天截图拼成一张长图发给朋友。', '把装修前后的照片并在一起看。', '把几个商品截图排在一张图里，方便全家一起挑。'],
  },
  'image-layout': {
    title: '做海报和封面', term: '图片排版', description: '把照片、文字和二维码放进一张图里', color: 'text-rose-500',
    start: '先定整张图大小，再添加照片或文字。选中一个元素就能单独调整。',
    examples: ['做张带时间和地点的生日邀请图，发到家人群。', '闲鱼出二手，把照片、型号和价格放到同一张图里。', '给活动做一张带报名二维码的通知图。'],
    keywords: '价签 图层 画布 邀请函',
  },
  'audio-edit': {
    title: '录声音、剪录音', term: '音频剪辑', description: '去掉多余部分，调响或调轻，试听后保存', color: 'text-emerald-500',
    start: '选录音，或用麦克风录一段。拖动时间条设置保留的开头和结尾。',
    examples: ['孩子朗读前后录进了闲聊，剪掉后再交作业。', '从长录音只取一段发言发给同事。', '给自录祝福调高音量，让开头和结尾听起来更自然。'],
    keywords: '录音与音频剪辑 剪录音 波形 wav 淡入淡出',
  },
  'subtitle-edit': {
    title: '给视频写字幕', term: '字幕编辑', description: '对着视频填字、对时间，保存成字幕文件', color: 'text-amber-500',
    start: '播放视频到想加字幕的位置，再点「在当前位置添加」。想让字幕直接显示在成品视频里，可到「剪视频、缩小文件」导入字幕。',
    examples: ['给做菜视频写步骤，别人静音也能看懂。', '修改已有字幕里的错别字或人名。', '片头加长了 3 秒，把后面的字幕整体推迟 3 秒。'],
    keywords: '打轴 SRT VTT 时间偏移',
  },
  'image-motion': {
    title: '让照片动起来', term: '图片动效', description: '给照片加缩放或滑动效果，配上音乐做成短片', color: 'text-violet-500',
    start: '先选一张或几张照片，再挑一种动作。点「播放预览」看看速度合不合适。',
    examples: ['把几张旅行照片做成十几秒的朋友圈短片。', '给生日照片加个慢慢放大，再配上祝福文字。', '把几张商品照配乐，做一段简单展示短片。'],
    keywords: '幻灯片 转场 幻灯相册',
  },
  'video-edit': {
    title: '剪视频、缩小文件', term: '视频处理', description: '只留想要的一段，也能转正、截图或单独保存声音', color: 'text-sky-500',
    start: '选视频后拖动时间条，标记开头和结尾。可以先播放选中的片段，再导出。',
    examples: ['孩子表演录了五分钟，只截最精彩的二十秒发家人群。', '视频太大传不上去，调小画面和文件后再发。', '从视频里保存一张合适的封面，或提取声音单独听。'],
    keywords: '压缩视频 视频太大 视频转音频 提取音频 转码 抽帧 MP4 WebM 剪辑 内嵌字幕',
  },
  'tone-generator': {
    title: '做一声提示铃', term: '提示音生成', description: '做计时结束铃、按键声或答题提示，先听再保存', color: 'text-amber-500',
    start: '先选一个现成样式试听。想调高低或长短，再打开下方设置。',
    examples: ['给自制计时器做一声轻一点的「叮」。', '给亲子小游戏做两种一听就能区分的提示。', '做一小段倒数铃声，放进运动或课堂活动视频。'],
    keywords: '音效 蜂鸣 波形 音高 hz wav',
  },
};

export function matchesTool(id: ToolId, query: string) {
  const tool = toolsCatalog[id];
  const terms = [id, tool.title, tool.term, tool.description, tool.start, tool.keywords, ...tool.examples].join(' ').toLowerCase();
  const keyword = query.trim().toLowerCase();
  const words = keyword.match(/[\p{L}\p{N}-]+/gu);
  return words ? words.every(word => terms.includes(word)) : terms.includes(keyword);
}

export function listTools(browseFilter: ToolFilter | null, query: string, pinnedIds: ToolId[], usage: ToolsState['usage'], searchFilter?: ToolFilter) {
  const searching = Boolean(query.trim());
  const all = toolOrder('all', usage).filter(id => !pinnedIds.includes(id) && (!searching || matchesTool(id, query)));
  const groups: Record<ToolFilter, ToolId[]> = {
    all,
    frequent: toolOrder('frequent', usage).filter(id => all.includes(id)),
    media: all.filter(isMediaToolId),
  };
  const counts = { all: groups.all.length, frequent: groups.frequent.length, media: groups.media.length };
  const preferredFilter = searching ? searchFilter ?? browseFilter : browseFilter;
  const filter = preferredFilter ?? (searching || !counts.frequent ? 'all' : 'frequent');
  const remaining = groups[filter];
  return { filter, pinned: pinnedIds, remaining, searching, counts, resultCount: remaining.length };
}
