import { MS_PER_SECOND } from './constants.js';

const s = (seconds) => seconds * MS_PER_SECOND;

export const SAMPLE_A = {
  sampleId: 'sample-a',
  name: '课堂录像工程（固定样例 A）',
  totalDurationMs: s(120),
  records: [
    { id: 'v1', track: 'video-1', name: '开场镜头', startMs: s(0), durationMs: s(20) },
    { id: 'v2', track: 'video-1', name: '板书讲解', startMs: s(20), durationMs: s(30) },
    { id: 'v2', track: 'video-1', name: '板书讲解', startMs: s(20), durationMs: s(30) },
    null,
    { id: 'v3', track: 'video-1', name: '学生互动', startMs: s(50), durationMs: s(25) },
    { id: 'v4', track: 'video-1', name: '超长结尾(越界)', startMs: s(90), durationMs: s(40) },
    { id: 'v5', track: 'video-1', name: '负时长坏片', startMs: s(60), durationMs: -s(5) },

    { id: 'a1', track: 'audio-a', name: '教师领夹麦 1', startMs: s(0), durationMs: s(25) },
    { id: 'a2', track: 'audio-a', name: '教师领夹麦 2', startMs: s(25), durationMs: s(15) },
    { id: 'a1', track: 'audio-a', name: '重复ID音频', startMs: s(60), durationMs: s(18) },
    { id: 'a4', track: 'audio-a', name: '讨论收音(离群长片)', startMs: s(78), durationMs: s(42) },

    { id: 'b1', track: 'audio-b', name: '环境声 1', startMs: s(10), durationMs: s(20) },
    { id: 'b2', track: 'audio-b', name: '环境声 2', startMs: s(70), durationMs: s(20) },
    { id: 'b3', track: 'audio-b', name: '空字段坏片', startMs: null, durationMs: s(10) },

    { id: 's1', track: 'sub-a', name: '中文字幕 1', text: '同学们好，我们开始上课', startMs: s(0), durationMs: s(8) },
    { id: 's2', track: 'sub-a', name: '中文字幕 2', text: '请翻开教材第 12 页', startMs: s(20), durationMs: s(10) },
    { id: 's3', track: 'sub-a', name: '中文字幕 3', text: '这段内容是重点', startMs: s(50), durationMs: s(12) },

    { id: 'e1', track: 'sub-b', name: '英文字幕 1', text: 'Hello everyone, class begins', startMs: s(0), durationMs: s(9) },
    { id: 'e1', track: 'sub-b', name: '英文字幕 1', text: 'Hello everyone, class begins', startMs: s(0), durationMs: s(9) },
    { id: 'e2', track: 'sub-b', name: '英文字幕 2', text: 'Open your book to page 12', startMs: s(20), durationMs: s(11) },

    { id: 'c1', track: 'sub-c', name: '字幕(坏轨道)', text: '不应出现', startMs: s(0), durationMs: s(5), track: 'sub-x' },
    { id: 'c2', track: 'sub-c', name: '实时弹幕字幕', text: '老师讲得清楚', startMs: s(80), durationMs: s(8) },
  ],
};

export const SAMPLE_B = {
  sampleId: 'sample-b',
  name: '短视频混剪工程（固定样例 B）',
  totalDurationMs: s(60),
  records: [
    { id: 'p1', track: 'video-1', name: '片头', startMs: s(0), durationMs: s(10) },
    { id: 'p2', track: 'video-1', name: '主片段', startMs: s(10), durationMs: s(20) },
    { id: 'p3', track: 'video-1', name: 'NaN起点坏片', startMs: Number.NaN, durationMs: s(5) },
    { id: 'p4', track: 'video-1', name: '无穷时长坏片', startMs: s(30), durationMs: Number.POSITIVE_INFINITY },
    { id: 'p5', track: 'video-1', name: '零时长坏片', startMs: s(30), durationMs: 0 },

    { id: 'q1', track: 'audio-a', name: '背景音乐', startMs: s(0), durationMs: s(45) },
    { id: 'q2', track: 'audio-a', name: '音效(离群短片)', startMs: s(45), durationMs: 300 },
    { id: 'q3', track: 'audio-a', name: '越界音效', startMs: s(55), durationMs: s(20) },

    { id: 'r1', track: 'audio-b', name: '人声 1', startMs: s(5), durationMs: s(15) },
    undefined,
    { id: 'r2', track: 'audio-b', name: '人声 2', startMs: s(30), durationMs: s(12) },

    { id: 't1', track: 'sub-a', name: '贴纸字幕', text: '一键三连', startMs: s(2), durationMs: s(6) },
    { id: 't2', track: 'sub-a', name: '贴纸字幕', text: '一键三连', startMs: s(2), durationMs: s(6) },
    { id: 't3', track: 'sub-a', name: '结尾字幕', text: '感谢观看', startMs: s(48), durationMs: s(7) },

    { id: 'u1', track: 'sub-b', name: '英文字幕', text: 'Like and subscribe', startMs: s(2), durationMs: s(6) },
    { id: 'u2', track: 'sub-b', name: '缺时长字幕', text: '坏数据', startMs: s(20), durationMs: undefined },

    { id: 'w1', track: 'sub-c', name: '备注字幕', text: '画面提示', startMs: s(33), durationMs: s(5) },
    { id: 'w2', track: 'sub-c', name: '负起点字幕', text: '坏数据', startMs: -s(3), durationMs: s(5) },
  ],
};

export const SAMPLES = [SAMPLE_A, SAMPLE_B];
