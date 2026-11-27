/**
 * LZHCard - 英文詞素拆解（字首/字根/字尾）、字根字典 AI 問答與全域單字搜尋模組 (morphology.js)
 */
(function (global) {
    'use strict';

    const STORAGE_KEY_MORPH = 'lzhcard_show_morphemes';

    const PREFIXES = [
        { key: 'anti', forms: ['anti'], meaningZh: '反對、對抗、防止', meaningEn: 'against, opposite', meaningJa: '反対・抗', origin: 'Greek', examples: ['antibiotic', 'antivirus', 'antipathy'] },
        { key: 'auto', forms: ['auto'], meaningZh: '自己、自動', meaningEn: 'self, same', meaningJa: '自己・自動', origin: 'Greek', examples: ['automatic', 'autobiography', 'autonomy'] },
        { key: 'bene', forms: ['bene'], meaningZh: '好、善、有益', meaningEn: 'good, well', meaningJa: '良い・善', origin: 'Latin', examples: ['benefit', 'benevolent', 'beneficial'] },
        { key: 'bio', forms: ['bio'], meaningZh: '生命、生物', meaningEn: 'life', meaningJa: '生命・生物', origin: 'Greek', examples: ['biology', 'biography', 'biodegradable'] },
        { key: 'circum', forms: ['circum'], meaningZh: '周圍、環繞', meaningEn: 'around', meaningJa: '周囲・回る', origin: 'Latin', examples: ['circumstance', 'circumvent', 'circumference'] },
        { key: 'co/com/con', forms: ['contra', 'counter', 'com', 'con', 'col', 'cor', 'co'], meaningZh: '共同、一起、完全（contra/counter 為相反）', meaningEn: 'with, together (contra/counter: against)', meaningJa: '共に・完全に', origin: 'Latin', examples: ['cooperate', 'combine', 'connect', 'contradict'] },
        { key: 'de', forms: ['de'], meaningZh: '向下、去除、減少、否定', meaningEn: 'down, away, reverse', meaningJa: '下へ・離脱・否定', origin: 'Latin', examples: ['decrease', 'decline', 'depart', 'decode'] },
        { key: 'dis/di', forms: ['dis', 'dif'], meaningZh: '不、分開、除去', meaningEn: 'not, apart, away', meaningJa: '否定・分離', origin: 'Latin', examples: ['disagree', 'discover', 'differ'] },
        { key: 'ex/e', forms: ['extra', 'ex', 'ef'], meaningZh: '向外、以前、超出（extra 為超越）', meaningEn: 'out, former, beyond', meaningJa: '外へ・前・超えて', origin: 'Latin', examples: ['export', 'exclude', 'extraordinary'] },
        { key: 'fore', forms: ['fore'], meaningZh: '在前面、預先', meaningEn: 'before, in front', meaningJa: '前・あらかじめ', origin: 'Old English', examples: ['forecast', 'foresee', 'forehead'] },
        { key: 'hyper', forms: ['hyper'], meaningZh: '過度、超過、極端', meaningEn: 'over, excessive', meaningJa: '過度・超', origin: 'Greek', examples: ['hyperactive', 'hypersensitive'] },
        { key: 'in/im/il/ir', forms: ['inter', 'intra', 'intro', 'in', 'im', 'il', 'ir'], meaningZh: '不、無、或向內（inter 在之間、intro 向內）', meaningEn: 'not / in, into (inter: between)', meaningJa: '否定・中へ（inter: 相互）', origin: 'Latin', examples: ['impossible', 'illegal', 'interact', 'introduce'] },
        { key: 'mal', forms: ['mal'], meaningZh: '壞、惡、不良', meaningEn: 'bad, ill', meaningJa: '悪い・不', origin: 'Latin', examples: ['malfunction', 'malnutrition', 'malicious'] },
        { key: 'micro', forms: ['micro'], meaningZh: '微小的', meaningEn: 'small', meaningJa: '微小な', origin: 'Greek', examples: ['microscope', 'microwave', 'microbe'] },
        { key: 'mis', forms: ['mis'], meaningZh: '錯誤地、不當地', meaningEn: 'wrongly, badly', meaningJa: '誤って', origin: 'Old English', examples: ['misunderstand', 'mistake', 'mislead'] },
        { key: 'mono', forms: ['mono'], meaningZh: '單一、一個', meaningEn: 'one, single', meaningJa: '単一・一つ', origin: 'Greek', examples: ['monologue', 'monopoly', 'monotone'] },
        { key: 'multi', forms: ['multi'], meaningZh: '多、許多', meaningEn: 'many, much', meaningJa: '多くの・多', origin: 'Latin', examples: ['multiple', 'multicultural', 'multimedia'] },
        { key: 'non', forms: ['non'], meaningZh: '非、不', meaningEn: 'not, without', meaningJa: '非・不', origin: 'Latin', examples: ['nonsense', 'nonprofit', 'nonstop'] },
        { key: 'out', forms: ['out'], meaningZh: '超過、勝過、向外', meaningEn: 'surpassing, out', meaningJa: '上回る・外へ', origin: 'Old English', examples: ['outperform', 'outcome', 'outstanding'] },
        { key: 'over', forms: ['over'], meaningZh: '過度、在上方', meaningEn: 'too much, above', meaningJa: '過度・上に', origin: 'Old English', examples: ['overcome', 'overlook', 'overestimate'] },
        { key: 'per', forms: ['per'], meaningZh: '貫穿、徹底、一直', meaningEn: 'through, thoroughly', meaningJa: '貫いて・完全に', origin: 'Latin', examples: ['persist', 'perceive', 'permanent'] },
        { key: 'poly', forms: ['poly'], meaningZh: '多、多種', meaningEn: 'many', meaningJa: '多い・多', origin: 'Greek', examples: ['polygon', 'polyglot'] },
        { key: 'post', forms: ['post'], meaningZh: '在⋯⋯之後', meaningEn: 'after', meaningJa: '後ろ・後', origin: 'Latin', examples: ['postpone', 'postwar', 'postgraduate'] },
        { key: 'pre', forms: ['pre'], meaningZh: '預先、在⋯⋯之前', meaningEn: 'before', meaningJa: '前・あらかじめ', origin: 'Latin', examples: ['predict', 'prepare', 'prevent', 'preview'] },
        { key: 'pro', forms: ['pro'], meaningZh: '向前、支持、贊成', meaningEn: 'forward, in favor of', meaningJa: '前へ・賛成', origin: 'Latin', examples: ['progress', 'promote', 'protect', 'provide'] },
        { key: 're', forms: ['re'], meaningZh: '再次、回到、向後', meaningEn: 'again, back', meaningJa: '再び・後ろへ', origin: 'Latin', examples: ['review', 'return', 'rebuild', 'reflect'] },
        { key: 'semi', forms: ['semi'], meaningZh: '半、部分的', meaningEn: 'half, partly', meaningJa: '半・部分', origin: 'Latin', examples: ['semicircle', 'semifinal', 'semiconductor'] },
        { key: 'sub/suc/sup', forms: ['sub', 'suc', 'suf', 'sup', 'sus'], meaningZh: '在⋯⋯下面、次要的、由下向上支撐', meaningEn: 'under, below, secondary', meaningJa: '下に・準・支える', origin: 'Latin', examples: ['subway', 'succeed', 'support', 'sustain'] },
        { key: 'super/sur', forms: ['super', 'sur'], meaningZh: '超越、在上方', meaningEn: 'above, over, beyond', meaningJa: '超・上に', origin: 'Latin', examples: ['supervise', 'superior', 'survive', 'surpass'] },
        { key: 'sym/syn', forms: ['sym', 'syn'], meaningZh: '共同、相同、一起', meaningEn: 'together, same', meaningJa: '共に・同じ', origin: 'Greek', examples: ['sympathy', 'symbol', 'synchronize', 'synthesis'] },
        { key: 'tele', forms: ['tele'], meaningZh: '遠距離', meaningEn: 'far, distant', meaningJa: '遠く', origin: 'Greek', examples: ['telephone', 'television', 'telescope'] },
        { key: 'trans', forms: ['trans'], meaningZh: '橫越、轉變、跨越', meaningEn: 'across, change', meaningJa: '越えて・変換', origin: 'Latin', examples: ['transport', 'translate', 'transform'] },
        { key: 'tri', forms: ['tri'], meaningZh: '三', meaningEn: 'three', meaningJa: '三', origin: 'Latin/Greek', examples: ['triangle', 'triple', 'tricycle'] },
        { key: 'un', forms: ['under', 'un'], meaningZh: '不、解除（under 為在⋯⋯之下／不足）', meaningEn: 'not, reverse (under: beneath)', meaningJa: '否定・解除（under: 下に）', origin: 'Old English', examples: ['unable', 'unlock', 'understand', 'underestimate'] },
        { key: 'uni', forms: ['uni'], meaningZh: '單一、統一', meaningEn: 'one, single', meaningJa: '一つ・統一', origin: 'Latin', examples: ['uniform', 'unique', 'unite', 'university'] }
    ];

    const ROOTS = [
        { key: 'act/ag', forms: ['act', 'ag'], meaningZh: '做、行動、驅動', meaningEn: 'do, act, drive', meaningJa: '行う・動かす', origin: 'Latin', examples: ['action', 'active', 'react', 'agent'] },
        { key: 'aud/audit', forms: ['audit', 'aud'], meaningZh: '聽', meaningEn: 'hear, listen', meaningJa: '聞く', origin: 'Latin', examples: ['audio', 'audience', 'audition'] },
        { key: 'bio', forms: ['bio'], meaningZh: '生命', meaningEn: 'life', meaningJa: '生命', origin: 'Greek', examples: ['biology', 'antibiotic', 'symbiosis'] },
        { key: 'cap/cept/ceiv', forms: ['cept', 'ceiv', 'cap', 'cip'], meaningZh: '拿、抓、取得', meaningEn: 'take, seize, hold', meaningJa: '取る・つかむ', origin: 'Latin', examples: ['accept', 'receive', 'capable', 'participate'] },
        { key: 'ced/ceed/cess', forms: ['ceed', 'cess', 'ced'], meaningZh: '走、前進、讓步', meaningEn: 'go, yield', meaningJa: '行く・譲る', origin: 'Latin', examples: ['proceed', 'succeed', 'access', 'recede'] },
        { key: 'chron', forms: ['chron'], meaningZh: '時間', meaningEn: 'time', meaningJa: '時間', origin: 'Greek', examples: ['chronic', 'synchronize', 'chronology'] },
        { key: 'cid/cis', forms: ['cid', 'cis'], meaningZh: '切、割、決定', meaningEn: 'cut, kill', meaningJa: '切る・決める', origin: 'Latin', examples: ['decide', 'precise', 'concise', 'incident'] },
        { key: 'claim/clam', forms: ['claim', 'clam'], meaningZh: '喊叫、宣稱', meaningEn: 'cry out, shout', meaningJa: '叫ぶ・主張する', origin: 'Latin', examples: ['claim', 'exclaim', 'proclaim'] },
        { key: 'clud/clus', forms: ['clud', 'clus'], meaningZh: '關閉、包含', meaningEn: 'shut, close', meaningJa: '閉じる', origin: 'Latin', examples: ['include', 'exclude', 'conclude', 'conclusion'] },
        { key: 'cred', forms: ['cred'], meaningZh: '相信、信任', meaningEn: 'believe, trust', meaningJa: '信じる', origin: 'Latin', examples: ['credit', 'incredible', 'credible'] },
        { key: 'cur/curs', forms: ['curs', 'cur'], meaningZh: '跑、發生、流動', meaningEn: 'run, flow', meaningJa: '走る・起こる', origin: 'Latin', examples: ['occur', 'current', 'excursion'] },
        { key: 'dict', forms: ['dict', 'dic'], meaningZh: '說、言辭', meaningEn: 'say, speak', meaningJa: '言う', origin: 'Latin', examples: ['predict', 'dictate', 'dictionary', 'indicate'] },
        { key: 'duc/duct', forms: ['duct', 'duc'], meaningZh: '引導、帶領', meaningEn: 'lead, bring', meaningJa: '導く', origin: 'Latin', examples: ['educate', 'produce', 'conduct', 'introduce'] },
        { key: 'fac/fact/fect/fic', forms: ['fact', 'fect', 'fic', 'fac'], meaningZh: '做、製造', meaningEn: 'make, do', meaningJa: '作る・する', origin: 'Latin', examples: ['factory', 'effect', 'efficient', 'benefit'] },
        { key: 'fer', forms: ['fer'], meaningZh: '攜帶、帶來、忍受', meaningEn: 'carry, bear, bring', meaningJa: '運ぶ・耐える', origin: 'Latin', examples: ['transfer', 'refer', 'prefer', 'differ'] },
        { key: 'flect/flex', forms: ['flect', 'flex'], meaningZh: '彎曲、反射', meaningEn: 'bend', meaningJa: '曲げる', origin: 'Latin', examples: ['reflect', 'flexible', 'inflect'] },
        { key: 'flu/flux', forms: ['flux', 'flu'], meaningZh: '流動', meaningEn: 'flow', meaningJa: '流れる', origin: 'Latin', examples: ['fluent', 'influence', 'fluctuate'] },
        { key: 'form', forms: ['form'], meaningZh: '形狀、形成', meaningEn: 'shape, form', meaningJa: '形・作る', origin: 'Latin', examples: ['transform', 'inform', 'reform', 'uniform'] },
        { key: 'gen', forms: ['gen'], meaningZh: '出生、產生、種類', meaningEn: 'birth, produce, kind', meaningJa: '生む・種族', origin: 'Greek/Latin', examples: ['generate', 'genetics', 'general'] },
        { key: 'grad/gress', forms: ['gress', 'grad'], meaningZh: '步、走、階級', meaningEn: 'step, go', meaningJa: '歩む・進む', origin: 'Latin', examples: ['progress', 'graduate', 'aggressive'] },
        { key: 'graph/gram', forms: ['graph', 'gram'], meaningZh: '寫、畫、紀錄', meaningEn: 'write, draw', meaningJa: '書く・記録', origin: 'Greek', examples: ['autograph', 'biography', 'program', 'diagram'] },
        { key: 'ject', forms: ['ject'], meaningZh: '投擲、拋出', meaningEn: 'throw, cast', meaningJa: '投げる', origin: 'Latin', examples: ['project', 'reject', 'inject', 'object'] },
        { key: 'lect/leg/lig', forms: ['lect', 'leg', 'lig'], meaningZh: '選擇、收集、讀', meaningEn: 'choose, gather, read', meaningJa: '選ぶ・集める・読む', origin: 'Latin', examples: ['collect', 'select', 'elect', 'intelligent'] },
        { key: 'log/logy', forms: ['logy', 'log'], meaningZh: '語言、學科、思考', meaningEn: 'word, study, reason', meaningJa: '言葉・学問', origin: 'Greek', examples: ['logic', 'biology', 'dialogue', 'apology'] },
        { key: 'mit/miss', forms: ['miss', 'mit'], meaningZh: '送出、發射', meaningEn: 'send, let go', meaningJa: '送る', origin: 'Latin', examples: ['transmit', 'submit', 'permit', 'mission'] },
        { key: 'mob/mot/mov', forms: ['mot', 'mov', 'mob'], meaningZh: '移動、推動', meaningEn: 'move', meaningJa: '動く', origin: 'Latin', examples: ['promote', 'motivate', 'mobile', 'remove'] },
        { key: 'pel/puls', forms: ['puls', 'pel'], meaningZh: '推、驅趕', meaningEn: 'drive, push', meaningJa: '押す・駆る', origin: 'Latin', examples: ['expel', 'compel', 'impulse', 'repel'] },
        { key: 'pend/pens', forms: ['pend', 'pens'], meaningZh: '懸掛、衡量、花費', meaningEn: 'hang, weigh, pay', meaningJa: '掛ける・払う', origin: 'Latin', examples: ['depend', 'suspend', 'expense', 'compensate'] },
        { key: 'phon', forms: ['phon'], meaningZh: '聲音', meaningEn: 'sound, voice', meaningJa: '音・声', origin: 'Greek', examples: ['telephone', 'symphony', 'microphone'] },
        { key: 'port', forms: ['port'], meaningZh: '搬運、港口', meaningEn: 'carry', meaningJa: '運ぶ', origin: 'Latin', examples: ['transport', 'export', 'import', 'support', 'report'] },
        { key: 'pos/pon', forms: ['pos', 'pon'], meaningZh: '放置、擺放', meaningEn: 'put, place', meaningJa: '置く', origin: 'Latin', examples: ['compose', 'propose', 'expose', 'postpone'] },
        { key: 'press', forms: ['press'], meaningZh: '壓、迫', meaningEn: 'press', meaningJa: '押す', origin: 'Latin', examples: ['express', 'impress', 'depress', 'compress'] },
        { key: 'rupt', forms: ['rupt'], meaningZh: '斷裂、打破', meaningEn: 'break, burst', meaningJa: '壊す・割る', origin: 'Latin', examples: ['interrupt', 'erupt', 'corrupt', 'disrupt'] },
        { key: 'scrib/script', forms: ['script', 'scrib'], meaningZh: '書寫', meaningEn: 'write', meaningJa: '書く', origin: 'Latin', examples: ['describe', 'subscribe', 'manuscript', 'prescription'] },
        { key: 'sens/sent', forms: ['sens', 'sent'], meaningZh: '感覺、思考', meaningEn: 'feel, think', meaningJa: '感じる', origin: 'Latin', examples: ['sense', 'sensitive', 'consent', 'sentiment'] },
        { key: 'serv', forms: ['serv'], meaningZh: '服務、保持、保護', meaningEn: 'serve, keep, save', meaningJa: '仕える・保つ', origin: 'Latin', examples: ['preserve', 'observe', 'reserve', 'deserve'] },
        { key: 'sist/sta/stit', forms: ['sist', 'stit', 'stat', 'sta'], meaningZh: '站立、持續', meaningEn: 'stand, set', meaningJa: '立つ', origin: 'Latin', examples: ['resist', 'persist', 'consist', 'constitute', 'status'] },
        { key: 'spec/spect/spic', forms: ['spect', 'spec', 'spic'], meaningZh: '看、觀察', meaningEn: 'look, see', meaningJa: '見る', origin: 'Latin', examples: ['inspect', 'respect', 'expect', 'perspective', 'suspicious'] },
        { key: 'struct', forms: ['struct'], meaningZh: '建造、構成', meaningEn: 'build', meaningJa: '建てる・組む', origin: 'Latin', examples: ['construct', 'structure', 'instruct', 'destroy'] },
        { key: 'tain/ten/tin', forms: ['tain', 'tin', 'ten'], meaningZh: '握住、保持、容納', meaningEn: 'hold, keep', meaningJa: '保つ', origin: 'Latin', examples: ['contain', 'maintain', 'obtain', 'sustain', 'continue'] },
        { key: 'tend/tens/tent', forms: ['tend', 'tens', 'tent'], meaningZh: '伸展、趨向', meaningEn: 'stretch, strive', meaningJa: '伸ばす・向かう', origin: 'Latin', examples: ['extend', 'intend', 'attend', 'tension', 'attention'] },
        { key: 'tract', forms: ['tract'], meaningZh: '拉、拖曳', meaningEn: 'pull, draw', meaningJa: '引く', origin: 'Latin', examples: ['attract', 'extract', 'distract', 'contract'] },
        { key: 'ven/vent', forms: ['vent', 'ven'], meaningZh: '來、到來', meaningEn: 'come', meaningJa: '来る', origin: 'Latin', examples: ['prevent', 'invent', 'event', 'convention'] },
        { key: 'vert/vers', forms: ['vert', 'vers'], meaningZh: '轉向、改變', meaningEn: 'turn', meaningJa: '回る・向ける', origin: 'Latin', examples: ['convert', 'reverse', 'diverse', 'universe'] },
        { key: 'vid/vis', forms: ['vid', 'vis'], meaningZh: '看見、視覺', meaningEn: 'see, look', meaningJa: '見る', origin: 'Latin', examples: ['video', 'vision', 'provide', 'evidence', 'supervise'] },
        { key: 'viv/vit', forms: ['viv', 'vit'], meaningZh: '活著、生命力', meaningEn: 'live, life', meaningJa: '生きる・命', origin: 'Latin', examples: ['survive', 'vivid', 'vital', 'revive'] },
        { key: 'voc/vok', forms: ['voc', 'vok'], meaningZh: '聲音、呼叫', meaningEn: 'call, voice', meaningJa: '呼ぶ・声', origin: 'Latin', examples: ['vocabulary', 'advocate', 'provoke', 'evoke'] }
    ];

    const SUFFIXES = [
        { key: 'tion/sion/ation', forms: ['ation', 'ition', 'tion', 'sion'], meaningZh: '名詞字尾：表示行為、過程或狀態', meaningEn: 'noun: action, state, result', meaningJa: '名詞化（行為・状態）', origin: 'Latin', examples: ['education', 'decision', 'information'] },
        { key: 'ment', forms: ['ment'], meaningZh: '名詞字尾：行為、結果或工具', meaningEn: 'noun: condition, result', meaningJa: '名詞化（結果・状態）', origin: 'Latin', examples: ['development', 'agreement', 'environment'] },
        { key: 'ness', forms: ['ness'], meaningZh: '名詞字尾：性質、狀態（常接形容詞後）', meaningEn: 'noun: state, quality', meaningJa: '名詞化（性質・状態）', origin: 'Old English', examples: ['happiness', 'kindness', 'awareness'] },
        { key: 'ity/ty', forms: ['ity', 'ty'], meaningZh: '名詞字尾：抽象性質、程度', meaningEn: 'noun: quality or state', meaningJa: '名詞化（性質）', origin: 'Latin', examples: ['ability', 'diversity', 'reality', 'safety'] },
        { key: 'ance/ence', forms: ['ance', 'ence'], meaningZh: '名詞字尾：狀態、行為或品質', meaningEn: 'noun: state or quality', meaningJa: '名詞化（状態・性質）', origin: 'Latin', examples: ['importance', 'confidence', 'difference'] },
        { key: 'er/or/ist', forms: ['ist', 'er', 'or'], meaningZh: '名詞字尾：做某事的人或物（專業者）', meaningEn: 'noun: person or thing that does', meaningJa: '〜する人・専門家', origin: 'Latin/Greek', examples: ['teacher', 'actor', 'scientist', 'artist'] },
        { key: 'ism', forms: ['ism'], meaningZh: '名詞字尾：主義、學說、現象', meaningEn: 'noun: doctrine, belief, practice', meaningJa: '〜主義・〜論', origin: 'Greek', examples: ['optimism', 'criticism', 'tourism'] },
        { key: 'ship', forms: ['ship'], meaningZh: '名詞字尾：關係、身分、技能', meaningEn: 'noun: position, skill, relation', meaningJa: '関係・身分・技術', origin: 'Old English', examples: ['friendship', 'leadership', 'scholarship'] },
        { key: 'able/ible', forms: ['able', 'ible'], meaningZh: '形容詞字尾：能夠⋯⋯的、值得⋯⋯的', meaningEn: 'adj: capable of being', meaningJa: '〜できる・〜に値する', origin: 'Latin', examples: ['comfortable', 'possible', 'reliable'] },
        { key: 'ful', forms: ['ful'], meaningZh: '形容詞字尾：充滿⋯⋯的、富有⋯⋯的', meaningEn: 'adj: full of', meaningJa: '〜に満ちた', origin: 'Old English', examples: ['helpful', 'wonderful', 'careful'] },
        { key: 'less', forms: ['less'], meaningZh: '形容詞字尾：沒有⋯⋯的、無⋯⋯的', meaningEn: 'adj: without', meaningJa: '〜のない', origin: 'Old English', examples: ['careless', 'hopeless', 'endless'] },
        { key: 'ous/ious', forms: ['ious', 'eous', 'ous'], meaningZh: '形容詞字尾：具有⋯⋯性質的、多⋯⋯的', meaningEn: 'adj: characterized by, full of', meaningJa: '〜の性質を持つ', origin: 'Latin', examples: ['famous', 'dangerous', 'various', 'curious'] },
        { key: 'ive/ative', forms: ['ative', 'itive', 'ive'], meaningZh: '形容詞字尾：具有⋯⋯傾向或性質的', meaningEn: 'adj: tending to, quality of', meaningJa: '〜の傾向がある', origin: 'Latin', examples: ['active', 'creative', 'effective', 'positive'] },
        { key: 'al/ial', forms: ['ial', 'al'], meaningZh: '形容詞字尾：與⋯⋯有關的', meaningEn: 'adj: relating to', meaningJa: '〜に関する', origin: 'Latin', examples: ['natural', 'global', 'essential', 'social'] },
        { key: 'ic/ical', forms: ['ical', 'ic'], meaningZh: '形容詞字尾：⋯⋯的、屬於⋯⋯的', meaningEn: 'adj: pertaining to', meaningJa: '〜的な', origin: 'Greek/Latin', examples: ['scientific', 'historic', 'practical'] },
        { key: 'ant/ent', forms: ['ant', 'ent'], meaningZh: '形容詞/名詞字尾：⋯⋯的（或行為者）', meaningEn: 'adj/noun: performing or being', meaningJa: '〜な・〜する人', origin: 'Latin', examples: ['important', 'different', 'confident', 'student'] },
        { key: 'ary/ory', forms: ['ary', 'ory'], meaningZh: '形容詞/名詞字尾：與⋯⋯相關的／場所', meaningEn: 'adj/noun: connected with, place', meaningJa: '〜に関する・場所', origin: 'Latin', examples: ['necessary', 'ordinary', 'laboratory', 'library'] },
        { key: 'ize/ise', forms: ['ize', 'ise'], meaningZh: '動詞字尾：使成為、使⋯⋯化', meaningEn: 'verb: make or become', meaningJa: '〜化する', origin: 'Greek', examples: ['realize', 'organize', 'emphasize'] },
        { key: 'ify', forms: ['ify'], meaningZh: '動詞字尾：使變成、使⋯⋯化', meaningEn: 'verb: make, cause to be', meaningJa: '〜にする', origin: 'Latin', examples: ['simplify', 'identify', 'clarify'] },
        { key: 'ate', forms: ['ate'], meaningZh: '動詞字尾（或形容詞）：使、造成', meaningEn: 'verb/adj: cause to be', meaningJa: '〜する・〜させる', origin: 'Latin', examples: ['create', 'educate', 'motivate', 'accurate'] },
        { key: 'en', forms: ['en'], meaningZh: '動詞/形容詞字尾：使變得（或材質製成）', meaningEn: 'verb/adj: make, become', meaningJa: '〜にする・なる', origin: 'Old English', examples: ['strengthen', 'weaken', 'golden'] },
        { key: 'ly', forms: ['ly'], meaningZh: '副詞字尾（少數為形容詞）：⋯⋯地', meaningEn: 'adv: in a manner', meaningJa: '〜に・〜らしく', origin: 'Old English', examples: ['quickly', 'carefully', 'friendly'] },
        { key: 'ing', forms: ['ing'], meaningZh: '動詞現在分詞/動名詞：正在⋯⋯／⋯⋯的事', meaningEn: 'participle/gerund', meaningJa: '現在分詞・動名詞', origin: 'Old English', examples: ['learning', 'interesting', 'building'] },
        { key: 'ed', forms: ['ed'], meaningZh: '過去式／過去分詞字尾：已⋯⋯的', meaningEn: 'past / past participle', meaningJa: '過去形・過去分詞', origin: 'Old English', examples: ['decided', 'excited', 'completed'] }
    ];

    const ALL_MORPHEMES = [
        ...PREFIXES.map(x => ({ ...x, type: 'prefix' })),
        ...ROOTS.map(x => ({ ...x, type: 'root' })),
        ...SUFFIXES.map(x => ({ ...x, type: 'suffix' }))
    ];

    const MORPH_POPOVER_ID = 'lzhMorphemePopover';
    const DRAWER_MODAL_ID = 'wordManagerDrawerModal';

    let drawerTab = 'morphemes'; // 'morphemes' | 'search'
    let morphQueryText = '';
    let morphAiHistory = []; // { role: 'user'|'ai', text }
    let globalWordSearchText = '';
    let globalWordAiResult = null;
    let isMorphAiBusy = false;
    let isGlobalSearchAiBusy = false;

    function escapeMorphHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function isEnabled() {
        try {
            return localStorage.getItem(STORAGE_KEY_MORPH) !== 'false';
        } catch (e) {
            return true;
        }
    }

    function setEnabled(enabled) {
        const val = Boolean(enabled);
        try {
            localStorage.setItem(STORAGE_KEY_MORPH, val ? 'true' : 'false');
        } catch (e) {}
        return val;
    }

    function getCurrentTargetLangSafe() {
        try {
            return localStorage.getItem('lzhcard_target_lang') || 'en';
        } catch (e) {
            return 'en';
        }
    }

    function getNativeMeaningForEntry(entry) {
        if (!entry) return '';
        let nativeLang = 'zh-TW';
        try { nativeLang = localStorage.getItem('lzhcard_native_lang') || 'zh-TW'; } catch (e) {}
        if (nativeLang === 'en') return entry.meaningEn || entry.meaningZh;
        if (nativeLang === 'ja') return entry.meaningJa || entry.meaningZh;
        return entry.meaningZh || entry.meaningEn;
    }

    function findMatchingPrefix(lowerWord) {
        const candidates = [];
        PREFIXES.forEach(entry => {
            entry.forms.forEach(form => {
                if (lowerWord.startsWith(form) && lowerWord.length - form.length >= 3) {
                    candidates.push({ form, entry });
                }
            });
        });
        candidates.sort((a, b) => b.form.length - a.form.length);
        return candidates[0] || null;
    }

    function findMatchingSuffix(lowerRem, allowShortStem = false) {
        const minStem = allowShortStem ? 2 : 3;
        const candidates = [];
        SUFFIXES.forEach(entry => {
            entry.forms.forEach(form => {
                if (lowerRem.endsWith(form) && lowerRem.length - form.length >= minStem) {
                    candidates.push({ form, entry });
                }
            });
        });
        candidates.sort((a, b) => b.form.length - a.form.length);
        return candidates[0] || null;
    }

    function findMatchingRootInStem(lowerStem) {
        const candidates = [];
        ROOTS.forEach(entry => {
            entry.forms.forEach(form => {
                const idx = lowerStem.indexOf(form);
                if (idx !== -1) {
                    candidates.push({ form, idx, entry });
                }
            });
        });
        // Prefer exact match, then longest root form, then earliest index
        candidates.sort((a, b) => {
            const exactA = a.form.length === lowerStem.length ? 1 : 0;
            const exactB = b.form.length === lowerStem.length ? 1 : 0;
            if (exactA !== exactB) return exactB - exactA;
            if (b.form.length !== a.form.length) return b.form.length - a.form.length;
            return a.idx - b.idx;
        });
        return candidates[0] || null;
    }

    /**
     * 🔬 單字拆解：精準切出 Prefix（藍）/ Root（綠）/ Suffix（琥珀），確保字母 100% 無遺漏還原
     */
    function analyzeWordMorphemes(rawWord) {
        const original = String(rawWord || '').trim();
        if (!original || !/^[A-Za-z][A-Za-z\-']*$/.test(original) || original.length < 4) {
            return { word: original, segments: original ? [{ text: original, type: 'plain', entry: null }] : [], hasMorpheme: false };
        }

        const lower = original.toLowerCase();
        const len = original.length;

        let prefixMatch = findMatchingPrefix(lower);
        let pLen = prefixMatch ? prefixMatch.form.length : 0;

        // Avoid breaking whole short roots by mistake (e.g. "act" in "action" or "under" alone)
        if (prefixMatch && len - pLen < 3) {
            prefixMatch = null;
            pLen = 0;
        }

        let afterPrefixLower = lower.slice(pLen);
        let suffixMatch = findMatchingSuffix(afterPrefixLower, pLen > 0);
        let sLen = suffixMatch ? suffixMatch.form.length : 0;

        // Validate that suffix isn't consuming part of a clear standalone word with no stem left
        if (suffixMatch && afterPrefixLower.length - sLen < 2) {
            suffixMatch = null;
            sLen = 0;
        }

        // If no prefix was matched, check if a root exists cleanly before checking fallback
        const stemStart = pLen;
        const stemEnd = len - sLen;
        const stemLower = lower.slice(stemStart, stemEnd);
        const rootMatch = findMatchingRootInStem(stemLower);

        // Guard against false prefix match when entire word is a direct root+suffix (e.g. "in" inside "inspect" is valid, but "re" in "read" would leave "ad")
        if (prefixMatch && !rootMatch && (stemEnd - stemStart) < 3) {
            const altSuffix = findMatchingSuffix(lower, false);
            const altStemLower = lower.slice(0, altSuffix ? len - altSuffix.form.length : len);
            const altRoot = findMatchingRootInStem(altStemLower);
            if (altRoot) {
                prefixMatch = null;
                pLen = 0;
                suffixMatch = altSuffix;
                sLen = altSuffix ? altSuffix.form.length : 0;
            }
        }

        const finalStemStart = pLen;
        const finalStemEnd = len - sLen;
        const finalStemLower = lower.slice(finalStemStart, finalStemEnd);
        const finalRoot = findMatchingRootInStem(finalStemLower);

        const segments = [];
        if (pLen > 0 && prefixMatch) {
            segments.push({
                text: original.slice(0, pLen),
                type: 'prefix',
                entry: { ...prefixMatch.entry, type: 'prefix' }
            });
        }

        if (finalRoot) {
            const rStart = finalStemStart + finalRoot.idx;
            const rEnd = rStart + finalRoot.form.length;
            if (rStart > finalStemStart) {
                segments.push({ text: original.slice(finalStemStart, rStart), type: 'plain', entry: null });
            }
            segments.push({
                text: original.slice(rStart, rEnd),
                type: 'root',
                entry: { ...finalRoot.entry, type: 'root' }
            });
            if (rEnd < finalStemEnd) {
                segments.push({ text: original.slice(rEnd, finalStemEnd), type: 'plain', entry: null });
            }
        } else if (finalStemEnd > finalStemStart) {
            // If we found prefix or suffix, treat middle stem as root/stem visually (without fake entry if unknown, or plain)
            segments.push({ text: original.slice(finalStemStart, finalStemEnd), type: 'plain', entry: null });
        }

        if (sLen > 0 && suffixMatch) {
            segments.push({
                text: original.slice(finalStemEnd),
                type: 'suffix',
                entry: { ...suffixMatch.entry, type: 'suffix' }
            });
        }

        const hasMorpheme = segments.some(s => s.type !== 'plain');
        if (!hasMorpheme) {
            return { word: original, segments: [{ text: original, type: 'plain', entry: null }], hasMorpheme: false };
        }
        return { word: original, segments, hasMorpheme: true };
    }

    function getMorphemeStyleMeta(type) {
        if (type === 'prefix') {
            return {
                label: '[字首]',
                fullName: '字首 (Prefix)',
                underlineCls: 'border-b-[3px] border-sky-500 dark:border-sky-400 hover:bg-sky-100/70 dark:hover:bg-sky-900/40',
                badgeCls: 'bg-sky-100 text-sky-800 dark:bg-sky-950/70 dark:text-sky-200 border-sky-300 dark:border-sky-700'
            };
        }
        if (type === 'root') {
            return {
                label: '[字根]',
                fullName: '字根 (Root)',
                underlineCls: 'border-b-[3px] border-emerald-500 dark:border-emerald-400 hover:bg-emerald-100/70 dark:hover:bg-emerald-900/40',
                badgeCls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-200 border-emerald-300 dark:border-emerald-700'
            };
        }
        return {
            label: '[字尾]',
            fullName: '字尾 (Suffix)',
            underlineCls: 'border-b-[3px] border-amber-500 dark:border-amber-400 hover:bg-amber-100/70 dark:hover:bg-amber-900/40',
            badgeCls: 'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-200 border-amber-300 dark:border-amber-700'
        };
    }

    function shouldHighlightCardWord(wordText, card = null) {
        if (!isEnabled()) return false;
        const clean = String(wordText || '').trim();
        if (!clean) return false;
        const lang = (card && card.lang) ? card.lang : getCurrentTargetLangSafe();
        if (lang && lang !== 'en' && lang !== 'custom') return false;
        return /[A-Za-z]{4,}/.test(clean);
    }

    /**
     * 🎨 產生字卡正面的三色詞素底線互動 HTML（支援單字或短片語，絕不翻牌）
     */
    function renderInteractiveCardWordHtml(wordText, card = null) {
        const clean = String(wordText || '').trim();
        if (!shouldHighlightCardWord(clean, card)) return null;

        const tokens = clean.split(/(\s+)/);
        let anyHit = false;
        const partsHtml = tokens.map(tok => {
            if (!tok) return '';
            if (/^\s+$/.test(tok)) return `<span class="whitespace-pre">${escapeMorphHtml(tok)}</span>`;
            const res = analyzeWordMorphemes(tok);
            if (!res.hasMorpheme) return escapeMorphHtml(tok);
            anyHit = true;
            return res.segments.map(seg => {
                if (seg.type === 'plain' || !seg.entry) {
                    return `<span>${escapeMorphHtml(seg.text)}</span>`;
                }
                const meta = getMorphemeStyleMeta(seg.type);
                return `<span role="button" tabindex="0" data-morph-key="${escapeMorphHtml(seg.entry.key)}" data-morph-type="${escapeMorphHtml(seg.type)}" data-morph-text="${escapeMorphHtml(seg.text)}" data-full-word="${escapeMorphHtml(clean)}" onclick="event.stopPropagation(); if(typeof MorphologyEngine!=='undefined') MorphologyEngine.showSegmentPopover(this, event);" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation(); if(typeof MorphologyEngine!=='undefined') MorphologyEngine.showSegmentPopover(this, event);}" title="${escapeMorphHtml(meta.fullName)}：${escapeMorphHtml(getNativeMeaningForEntry(seg.entry))}" class="morph-seg inline-block cursor-pointer rounded-xs px-0.5 transition-colors ${meta.underlineCls}">${escapeMorphHtml(seg.text)}</span>`;
            }).join('');
        }).join('');

        if (!anyHit) return null;

        return `<span class="inline leading-tight">${partsHtml}</span>`;
    }

    function ensurePopoverDom() {
        if (typeof document === 'undefined') return null;
        let pop = document.getElementById(MORPH_POPOVER_ID);
        if (pop) return pop;
        pop = document.createElement('div');
        pop.id = MORPH_POPOVER_ID;
        pop.className = 'hidden fixed z-[88] w-72 max-w-[90vw] bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 p-4 space-y-2.5';
        pop.addEventListener('click', (e) => e.stopPropagation());
        document.body.appendChild(pop);

        document.addEventListener('click', (e) => {
            const p = document.getElementById(MORPH_POPOVER_ID);
            if (!p || p.classList.contains('hidden')) return;
            if (p.contains(e.target) || (e.target && e.target.closest && e.target.closest('.morph-seg'))) return;
            hideSegmentPopover();
        });
        return pop;
    }

    function hideSegmentPopover() {
        const pop = typeof document !== 'undefined' ? document.getElementById(MORPH_POPOVER_ID) : null;
        if (pop) pop.classList.add('hidden');
    }

    function showSegmentPopover(elem, ev = null) {
        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
        if (!elem || typeof document === 'undefined') return;

        const key = elem.getAttribute('data-morph-key') || '';
        const type = elem.getAttribute('data-morph-type') || 'root';
        const segText = elem.getAttribute('data-morph-text') || '';
        const fullWord = elem.getAttribute('data-full-word') || '';

        const entry = ALL_MORPHEMES.find(m => m.key === key && m.type === type) || ALL_MORPHEMES.find(m => m.key === key);
        if (!entry) return;

        const pop = ensurePopoverDom();
        if (!pop) return;
        const meta = getMorphemeStyleMeta(type);
        const meaning = getNativeMeaningForEntry(entry);

        pop.innerHTML = `
            <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="px-2 py-0.5 rounded-md border text-[10px] font-black ${meta.badgeCls}">${escapeMorphHtml(meta.label)} ${escapeMorphHtml(meta.fullName)}</span>
                    <span class="text-sm font-black text-slate-900 dark:text-white font-mono">${escapeMorphHtml(segText)}- (${escapeMorphHtml(entry.key)})</span>
                </div>
                <button type="button" onclick="MorphologyEngine.hideSegmentPopover()" class="w-7 h-7 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 flex items-center justify-center cursor-pointer">
                    <i class="fa-solid fa-xmark text-xs"></i>
                </button>
            </div>
            <div class="text-xs font-bold text-slate-800 dark:text-slate-100 leading-relaxed">${escapeMorphHtml(meaning)}</div>
            <div class="text-[11px] text-slate-500 dark:text-slate-400">
                來源語根：${escapeMorphHtml(entry.origin)} · 同源字例：<span class="font-mono text-slate-700 dark:text-slate-200">${escapeMorphHtml((entry.examples || []).join(', '))}</span>
            </div>
            <div class="pt-1 flex justify-end gap-1.5">
                <button type="button" onclick="MorphologyEngine.hideSegmentPopover(); MorphologyEngine.openWordManagerDrawer('morphemes', '${escapeMorphHtml(fullWord ? fullWord + ' 中的詞素 ' + segText : entry.key)}', '${escapeMorphHtml(entry.key)}');" class="px-3 py-1.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-[11px] font-extrabold transition cursor-pointer inline-flex items-center gap-1">
                    <span>詞素字典 & ✨ AI 問答</span>
                </button>
            </div>
        `;

        pop.classList.remove('hidden');
        const rect = elem.getBoundingClientRect();
        const winW = window.innerWidth || 375;
        const winH = window.innerHeight || 667;
        const popW = Math.min(288, winW - 24);
        const popH = pop.offsetHeight || 170;

        let top = rect.bottom + 10;
        if (top + popH > winH - 16) {
            top = Math.max(16, rect.top - popH - 10);
        }
        let left = rect.left + rect.width / 2 - popW / 2;
        left = Math.max(12, Math.min(left, winW - popW - 12));

        pop.style.top = `${top}px`;
        pop.style.left = `${left}px`;
    }

    // =========================================================================
    // 📚 字庫管理左上角「☰」多功能抽屜：1. 字根字首字典＆AI 問答  2. 全域單字搜尋
    // =========================================================================
    function ensureWordManagerDrawerDom() {
        if (typeof document === 'undefined') return null;
        let modal = document.getElementById(DRAWER_MODAL_ID);
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = DRAWER_MODAL_ID;
        modal.className = 'hidden fixed inset-0 z-[76] bg-slate-950/65 backdrop-blur-xs items-center justify-center p-3 sm:p-5 lzh-safe-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.innerHTML = `
            <div class="bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded-2xl max-w-2xl w-full max-h-[90vh] flex flex-col shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                <div class="px-5 py-3.5 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-slate-50 dark:bg-slate-900/70 shrink-0">
                    <div class="flex items-center gap-2.5">
                        <span class="w-9 h-9 rounded-xl bg-brand-100 dark:bg-brand-950/60 text-brand-600 dark:text-brand-400 flex items-center justify-center">
                            <i class="fa-solid fa-bars"></i>
                        </span>
                        <div>
                            <h3 class="font-extrabold text-sm text-slate-900 dark:text-white">字庫進階工具選單</h3>
                            <p class="text-[11px] text-slate-400">字根字首字典（藍首 / 綠根 / 琥珀尾）與全域 7000 單搜尋</p>
                        </div>
                    </div>
                    <button type="button" onclick="MorphologyEngine.closeWordManagerDrawer()" class="min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg cursor-pointer">
                        <i class="fa-solid fa-xmark text-lg"></i>
                    </button>
                </div>

                <div class="px-4 pt-3 pb-2 border-b border-slate-100 dark:border-slate-700 grid grid-cols-2 gap-2 shrink-0">
                    <button type="button" id="wmTabMorphemesBtn" onclick="MorphologyEngine.switchDrawerTab('morphemes')" class="min-h-[44px] py-2 px-3 rounded-xl text-xs font-extrabold transition cursor-pointer">
                        🧩 字根字首字典＆AI 問答
                    </button>
                    <button type="button" id="wmTabSearchBtn" onclick="MorphologyEngine.switchDrawerTab('search')" class="min-h-[44px] py-2 px-3 rounded-xl text-xs font-extrabold transition cursor-pointer">
                        🔍 全域單字搜尋
                    </button>
                </div>

                <div id="wmDrawerBody" class="p-4 sm:p-5 overflow-y-auto flex-1 space-y-4"></div>
            </div>
        `;
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeWordManagerDrawer();
        });
        document.body.appendChild(modal);
        return modal;
    }

    function openWordManagerDrawer(tab = 'morphemes', initialPrompt = '', filterKey = '') {
        const modal = ensureWordManagerDrawerDom();
        if (!modal) return;
        drawerTab = tab === 'search' ? 'search' : 'morphemes';
        if (filterKey) morphQueryText = filterKey;
        if (initialPrompt && drawerTab === 'morphemes') {
            setTimeout(() => {
                const askInput = document.getElementById('wmMorphAiQuestionInput');
                if (askInput && !askInput.value.trim()) askInput.value = initialPrompt;
            }, 40);
        }
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        renderWordManagerDrawer();
    }

    function closeWordManagerDrawer() {
        const modal = typeof document !== 'undefined' ? document.getElementById(DRAWER_MODAL_ID) : null;
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    }

    function switchDrawerTab(tab) {
        drawerTab = tab === 'search' ? 'search' : 'morphemes';
        renderWordManagerDrawer();
    }

    function renderWordManagerDrawer() {
        if (typeof document === 'undefined') return;
        const tabMorphBtn = document.getElementById('wmTabMorphemesBtn');
        const tabSearchBtn = document.getElementById('wmTabSearchBtn');
        const body = document.getElementById('wmDrawerBody');
        if (!body) return;

        const activeCls = 'min-h-[44px] py-2 px-3 rounded-xl text-xs font-extrabold transition cursor-pointer bg-brand-600 text-white shadow-xs';
        const idleCls = 'min-h-[44px] py-2 px-3 rounded-xl text-xs font-extrabold transition cursor-pointer bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700';

        if (tabMorphBtn) tabMorphBtn.className = drawerTab === 'morphemes' ? activeCls : idleCls;
        if (tabSearchBtn) tabSearchBtn.className = drawerTab === 'search' ? activeCls : idleCls;

        if (drawerTab === 'morphemes') {
            renderMorphemeDictionaryTab(body);
        } else {
            renderGlobalWordSearchTab(body);
        }
    }

    function renderMorphemeDictionaryTab(container) {
        const q = String(morphQueryText || '').trim().toLowerCase();
        const matches = ALL_MORPHEMES.filter(m => {
            if (!q) return true;
            return m.key.toLowerCase().includes(q)
                || m.forms.some(f => f.toLowerCase().includes(q))
                || m.meaningZh.toLowerCase().includes(q)
                || m.meaningEn.toLowerCase().includes(q)
                || (m.examples || []).some(ex => ex.toLowerCase().includes(q));
        });

        const cardsHtml = matches.length > 0
            ? matches.slice(0, 40).map(m => {
                const meta = getMorphemeStyleMeta(m.type);
                return `
                    <div class="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/60 space-y-1.5">
                        <div class="flex items-center justify-between gap-2 flex-wrap">
                            <div class="flex items-center gap-2">
                                <span class="px-2 py-0.5 rounded-md border text-[10px] font-black ${meta.badgeCls}">${escapeMorphHtml(meta.label)}</span>
                                <span class="font-mono font-extrabold text-sm text-slate-900 dark:text-white">${escapeMorphHtml(m.key)}</span>
                                <span class="text-[10px] text-slate-400">(${escapeMorphHtml(m.origin)})</span>
                            </div>
                            <button type="button" onclick="MorphologyEngine.askAiFollowUpForMorpheme('${escapeMorphHtml(m.key)}')" class="px-2.5 py-1 rounded-lg bg-purple-50 dark:bg-purple-950/50 hover:bg-purple-100 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800 text-[10px] font-extrabold cursor-pointer">
                                ✨ AI 延伸問答
                            </button>
                        </div>
                        <div class="text-xs font-bold text-slate-700 dark:text-slate-200">${escapeMorphHtml(getNativeMeaningForEntry(m))}</div>
                        <div class="text-[11px] text-slate-500 dark:text-slate-400">
                            例字：<span class="font-mono text-slate-700 dark:text-slate-300">${escapeMorphHtml((m.examples || []).join(', '))}</span>
                        </div>
                    </div>
                `;
            }).join('')
            : `
                <div class="p-4 rounded-xl bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-center space-y-2">
                    <p class="text-xs font-bold text-amber-800 dark:text-amber-200">預設詞素庫尚未收錄「${escapeMorphHtml(q)}」</p>
                    <p class="text-[11px] text-amber-700/80 dark:text-amber-300/80">可直接使用下方 AI 問答功能查詢該字根／字首詳細演變與同源家族。</p>
                    <button type="button" onclick="MorphologyEngine.askAiAboutText('請詳細解析英文詞素（字根/字首/字尾）「${escapeMorphHtml(q)}」的來源、核心含義，並舉 5 個常見單字拆解例字。')" class="min-h-[40px] px-4 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-extrabold shadow-xs cursor-pointer inline-flex items-center gap-1.5">
                        <span>✨ AI 查詢「${escapeMorphHtml(q)}」</span>
                        <span class="px-1.5 py-0.5 rounded bg-white/20 text-[10px]">消耗解析額度</span>
                    </button>
                </div>
            `;

        const historyHtml = morphAiHistory.length > 0
            ? `<div class="space-y-2 max-h-48 overflow-y-auto p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
                ${morphAiHistory.map(msg => `
                    <div class="${msg.role === 'user' ? 'text-right' : 'text-left'}">
                        <div class="inline-block max-w-[92%] px-3 py-2 rounded-xl text-xs whitespace-pre-wrap leading-relaxed ${
                            msg.role === 'user'
                                ? 'bg-brand-600 text-white font-bold'
                                : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700'
                        }">${escapeMorphHtml(msg.text)}</div>
                    </div>
                `).join('')}
               </div>`
            : '';

        container.innerHTML = `
            <div class="space-y-3">
                <div class="relative">
                    <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-3 text-slate-400 text-xs"></i>
                    <input type="text" id="wmMorphSearchInput" value="${escapeMorphHtml(morphQueryText)}" oninput="MorphologyEngine.onMorphFilterInput(this.value)" placeholder="搜尋預設字根 / 字首 / 字尾（如 spect, pre, tion, 拉丁「看」...）" class="w-full min-h-[42px] pl-9 pr-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 outline-none focus:ring-2 focus:ring-brand-500 font-semibold">
                </div>
                <div class="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                    <span>收錄詞素：<strong class="tabular-nums text-slate-700 dark:text-slate-200">${matches.length}</strong> 筆（預設免費免額度查詢）</span>
                    <div class="flex items-center gap-2">
                        <span class="border-b-2 border-sky-500 px-1 font-bold text-sky-700 dark:text-sky-300">[字首]</span>
                        <span class="border-b-2 border-emerald-500 px-1 font-bold text-emerald-700 dark:text-emerald-300">[字根]</span>
                        <span class="border-b-2 border-amber-500 px-1 font-bold text-amber-700 dark:text-amber-300">[字尾]</span>
                    </div>
                </div>
                <div class="space-y-2 max-h-60 overflow-y-auto pr-1">
                    ${cardsHtml}
                </div>

                <div class="pt-3 border-t border-slate-200 dark:border-slate-700 space-y-2.5">
                    <div class="flex items-center justify-between gap-2 flex-wrap">
                        <div class="text-xs font-extrabold text-purple-700 dark:text-purple-300 flex items-center gap-1.5">
                            <span>✨ AI 詞素自由問答</span>
                            <span class="px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 text-[10px] border border-purple-200 dark:border-purple-800">消耗解析額度</span>
                        </div>
                        ${morphAiHistory.length > 0 ? `<button type="button" onclick="MorphologyEngine.clearMorphAiHistory()" class="text-[11px] text-slate-400 hover:text-rose-500 font-bold cursor-pointer">清除對話</button>` : ''}
                    </div>
                    ${historyHtml}
                    <form onsubmit="event.preventDefault(); MorphologyEngine.submitMorphAiQuestion();" class="flex gap-2">
                        <input type="text" id="wmMorphAiQuestionInput" placeholder="發問任何單字拆解、字根來源或形近詞素比較（如：inspect 跟 perspective 差在哪？）" class="flex-1 min-h-[44px] px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 outline-none focus:ring-2 focus:ring-purple-500">
                        <button type="submit" ${isMorphAiBusy ? 'disabled' : ''} class="min-h-[44px] px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-xs font-extrabold shrink-0 cursor-pointer">
                            ${isMorphAiBusy ? '思考中...' : '✨ AI 發問'}
                        </button>
                    </form>
                </div>
            </div>
        `;
    }

    function onMorphFilterInput(val) {
        morphQueryText = String(val || '');
        const body = document.getElementById('wmDrawerBody');
        if (body && drawerTab === 'morphemes') {
            renderMorphemeDictionaryTab(body);
            const inp = document.getElementById('wmMorphSearchInput');
            if (inp) {
                inp.focus();
                inp.setSelectionRange(inp.value.length, inp.value.length);
            }
        }
    }

    function clearMorphAiHistory() {
        morphAiHistory = [];
        renderWordManagerDrawer();
    }

    function askAiFollowUpForMorpheme(key) {
        const inp = document.getElementById('wmMorphAiQuestionInput');
        if (inp) {
            inp.value = `請詳細補充字素「${key}」的延伸單字家族與記憶聯想口訣，並比較容易混淆的形近字根。`;
            inp.focus();
        }
    }

    async function submitMorphAiQuestion() {
        const inp = document.getElementById('wmMorphAiQuestionInput');
        const question = inp ? inp.value.trim() : '';
        if (!question) {
            if (typeof showToast === 'function') showToast('請輸入要發問的詞素或單字問題！', 'warning');
            return;
        }
        await askAiAboutText(question);
    }

    async function askAiAboutText(question) {
        if (isMorphAiBusy) return;
        if (typeof global.callGeminiApi !== 'function') {
            if (typeof showToast === 'function') showToast('AI 引擎尚未就緒', 'error');
            return;
        }
        isMorphAiBusy = true;
        morphAiHistory.push({ role: 'user', text: question });
        renderWordManagerDrawer();

        const recentCtx = morphAiHistory.slice(-6).map(m => `${m.role === 'user' ? '使用者' : '老師'}: ${m.text}`).join('\n');
        const prompt = `你是一位精通英文構詞學（Word Roots, Prefixes, Suffixes）與語源學的專業教師。
請以繁體中文簡潔、結構化地回答學生的發問，並視需要列出 [字首] + [字根] + [字尾] 拆解與 3~5 個代表例字。
對話紀錄：\n${recentCtx}\n\n請直接回覆（純文字條列，無需 Markdown 語法糖過多）。`;

        try {
            const reply = await global.callGeminiApi(prompt, { feature: 'def_fill' });
            morphAiHistory.push({ role: 'ai', text: String(reply || '目前無回應').trim() });
        } catch (err) {
            morphAiHistory.push({ role: 'ai', text: `⚠️ 無法取得 AI 回覆：${err.message}` });
        } finally {
            isMorphAiBusy = false;
            renderWordManagerDrawer();
        }
    }

    // =========================================================================
    // 🔍 Tab 2：全域單字搜尋（玩家所有字庫 + 7000 單字庫 + AI 查字補充）
    // =========================================================================
    function buildGlobalSearchResults(rawQuery) {
        const q = String(rawQuery || '').trim().toLowerCase();
        if (!q) return { playerHits: [], vocabHits: [] };

        const list = Array.isArray(global.wordList) ? global.wordList : [];
        const playerHits = list.filter(w => {
            if (!w) return false;
            return String(w.word || '').toLowerCase().includes(q)
                || String(w.meaning || '').toLowerCase().includes(q)
                || String(w.category || '').toLowerCase().includes(q);
        }).slice(0, 30);

        const vocabData = Array.isArray(global.VOCAB_7000_DATA) ? global.VOCAB_7000_DATA : [];
        const vocabHits = [];
        for (let i = 0; i < vocabData.length && vocabHits.length < 30; i++) {
            const item = vocabData[i];
            if (!item) continue;
            const w = String(item.Word || item.word || '').trim();
            const meaningsArr = [];
            if (Array.isArray(item.Definitions)) {
                item.Definitions.forEach(d => { if (d && d.Meaning) meaningsArr.push(d.Meaning); });
            }
            const zh = meaningsArr.join('；') || String(item.Meaning || item.meaning || '');
            if (w.toLowerCase().includes(q) || zh.toLowerCase().includes(q)) {
                vocabHits.push({
                    word: w,
                    level: item.Level || item.level || '',
                    pos: Array.isArray(item.PartsOfSpeech) ? item.PartsOfSpeech.join(', ') : (item.pos || ''),
                    meaning: zh,
                    phonetic: item.Phonetic || item.phonetic || ''
                });
            }
        }
        return { playerHits, vocabHits };
    }

    function renderGlobalWordSearchTab(container) {
        const q = String(globalWordSearchText || '').trim();
        const { playerHits, vocabHits } = buildGlobalSearchResults(q);
        const existingSet = new Set((Array.isArray(global.wordList) ? global.wordList : []).map(w => String(w.word || '').trim().toLowerCase()));

        let bodyHtml = '';
        if (!q) {
            bodyHtml = `
                <div class="p-6 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-center space-y-1.5">
                    <p class="text-xs font-bold text-slate-700 dark:text-slate-200">輸入關鍵字進行跨字庫與 7000 單全域搜尋</p>
                    <p class="text-[11px] text-slate-400">優先免費檢索您的所有個人字庫與系統預載高中 7000 單（含 L1～L6 分級）；未收錄字詞可使用 ✨ AI 查字並一鍵加入字庫。</p>
                </div>
            `;
        } else {
            const pHtml = playerHits.length > 0 ? `
                <div class="space-y-1.5">
                    <div class="text-[11px] font-extrabold text-emerald-700 dark:text-emerald-300">📁 個人字庫符合結果 (${playerHits.length})</div>
                    ${playerHits.map(w => `
                        <div class="p-2.5 rounded-xl bg-emerald-50/60 dark:bg-emerald-950/25 border border-emerald-200 dark:border-emerald-800/70 flex items-center justify-between gap-2">
                            <div class="min-w-0">
                                <div class="flex items-center gap-1.5 flex-wrap">
                                    <span class="font-extrabold text-xs text-slate-900 dark:text-white">${escapeMorphHtml(w.word)}</span>
                                    ${w.pos ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300">${escapeMorphHtml(w.pos)}</span>` : ''}
                                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 font-bold">${escapeMorphHtml(w.category || '預設字庫')}</span>
                                </div>
                                <div class="text-[11px] text-slate-600 dark:text-slate-300 truncate mt-0.5">${escapeMorphHtml(w.meaning || '')}</div>
                            </div>
                            <span class="text-[10px] font-bold text-emerald-700 dark:text-emerald-300 shrink-0">Lv.${Number(w.level) || 1}</span>
                        </div>
                    `).join('')}
                </div>
            ` : '';

            const vHtml = vocabHits.length > 0 ? `
                <div class="space-y-1.5">
                    <div class="text-[11px] font-extrabold text-brand-700 dark:text-brand-300">🎓 內建 7000 單分級詞庫符合結果 (${vocabHits.length})</div>
                    ${vocabHits.map((v, idx) => {
                        const already = existingSet.has(v.word.toLowerCase());
                        return `
                            <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2">
                                <div class="min-w-0 flex-1">
                                    <div class="flex items-center gap-1.5 flex-wrap">
                                        <span class="font-extrabold text-xs text-slate-900 dark:text-white">${escapeMorphHtml(v.word)}</span>
                                        ${v.level ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-brand-100 dark:bg-brand-950/60 text-brand-700 dark:text-brand-300 font-black">L${escapeMorphHtml(v.level)}</span>` : ''}
                                        ${v.pos ? `<span class="text-[10px] text-slate-400 font-semibold">${escapeMorphHtml(v.pos)}</span>` : ''}
                                    </div>
                                    <div class="text-[11px] text-slate-600 dark:text-slate-300 mt-0.5">${escapeMorphHtml(v.meaning || '（無釋義）')}</div>
                                </div>
                                ${already
                                    ? `<span class="px-2.5 py-1 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400 text-[10px] font-bold shrink-0">已在字庫</span>`
                                    : `<button type="button" onclick="MorphologyEngine.quickAddSearchedWord(${idx}, 'vocab')" class="min-h-[36px] px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-extrabold shrink-0 cursor-pointer">＋ 加入字庫</button>`
                                }
                            </div>
                        `;
                    }).join('')}
                </div>
            ` : '';

            const exactFound = playerHits.some(w => String(w.word || '').trim().toLowerCase() === q.toLowerCase())
                || vocabHits.some(v => String(v.word || '').trim().toLowerCase() === q.toLowerCase());

            const aiFallbackHtml = (!exactFound) ? `
                <div class="p-3.5 rounded-xl bg-purple-50/80 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800 space-y-2.5">
                    <div class="flex items-center justify-between gap-2 flex-wrap">
                        <div class="text-xs font-bold text-purple-900 dark:text-purple-200">
                            ${playerHits.length === 0 && vocabHits.length === 0 ? `未在個人字庫與 7000 單查到完全相符的「${escapeMorphHtml(q)}」` : `想直接查詢「${escapeMorphHtml(q)}」的完整解釋與例句嗎？`}
                        </div>
                        <button type="button" ${isGlobalSearchAiBusy ? 'disabled' : ''} onclick="MorphologyEngine.lookupWordWithAi('${escapeMorphHtml(q)}')" class="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-xs font-extrabold cursor-pointer inline-flex items-center gap-1.5">
                            <span>${isGlobalSearchAiBusy ? '查詢中...' : '✨ AI 查字'}</span>
                            <span class="px-1.5 py-0.5 rounded bg-white/20 text-[10px]">消耗解析額度</span>
                        </button>
                    </div>
                    ${globalWordAiResult && globalWordAiResult.word ? `
                        <div class="p-3 rounded-xl bg-white dark:bg-slate-800 border border-purple-200 dark:border-purple-700 space-y-1.5">
                            <div class="flex items-center justify-between gap-2 flex-wrap">
                                <div class="flex items-center gap-2">
                                    <span class="font-extrabold text-sm text-slate-900 dark:text-white">${escapeMorphHtml(globalWordAiResult.word)}</span>
                                    ${globalWordAiResult.pos ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-brand-50 dark:bg-brand-950 text-brand-700 dark:text-brand-300 font-bold">${escapeMorphHtml(globalWordAiResult.pos)}</span>` : ''}
                                    ${globalWordAiResult.phonetic ? `<span class="text-[11px] font-mono text-slate-500">${escapeMorphHtml(globalWordAiResult.phonetic)}</span>` : ''}
                                </div>
                                <button type="button" onclick="MorphologyEngine.quickAddSearchedWord(0, 'ai')" class="min-h-[36px] px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-extrabold cursor-pointer">＋ 加入字庫</button>
                            </div>
                            <div class="text-xs font-bold text-slate-800 dark:text-slate-100">${escapeMorphHtml(globalWordAiResult.meaning || '')}</div>
                            ${globalWordAiResult.sentence ? `<div class="text-[11px] text-slate-600 dark:text-slate-300 italic">"${escapeMorphHtml(globalWordAiResult.sentence)}"</div>` : ''}
                            ${globalWordAiResult.translation ? `<div class="text-[11px] text-slate-400">${escapeMorphHtml(globalWordAiResult.translation)}</div>` : ''}
                        </div>
                    ` : ''}
                </div>
            ` : '';

            bodyHtml = `${pHtml}${vHtml}${aiFallbackHtml}`;
        }

        container.innerHTML = `
            <div class="space-y-3">
                <div class="relative">
                    <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-3 text-slate-400 text-xs"></i>
                    <input type="text" id="wmGlobalWordSearchInput" value="${escapeMorphHtml(globalWordSearchText)}" oninput="MorphologyEngine.onGlobalWordSearchInput(this.value)" placeholder="輸入單字或中文釋義（跨個人全字庫 ＋ 7000 單檢索）..." class="w-full min-h-[44px] pl-9 pr-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 outline-none focus:ring-2 focus:ring-brand-500 font-semibold">
                </div>
                <div class="space-y-3 max-h-[54vh] overflow-y-auto pr-1">
                    ${bodyHtml}
                </div>
            </div>
        `;
    }

    function onGlobalWordSearchInput(val) {
        globalWordSearchText = String(val || '');
        if (globalWordAiResult && String(globalWordAiResult.word || '').toLowerCase() !== globalWordSearchText.trim().toLowerCase()) {
            globalWordAiResult = null;
        }
        const body = document.getElementById('wmDrawerBody');
        if (body && drawerTab === 'search') {
            renderGlobalWordSearchTab(body);
            const inp = document.getElementById('wmGlobalWordSearchInput');
            if (inp) {
                inp.focus();
                inp.setSelectionRange(inp.value.length, inp.value.length);
            }
        }
    }

    async function lookupWordWithAi(wordQuery) {
        const clean = String(wordQuery || '').trim();
        if (!clean || isGlobalSearchAiBusy) return;
        isGlobalSearchAiBusy = true;
        renderWordManagerDrawer();
        try {
            let filled = null;
            if (typeof global.autoFillWithAI === 'function') {
                filled = await global.autoFillWithAI(clean);
            } else if (typeof global.callGeminiApi === 'function') {
                const raw = await global.callGeminiApi(`請為單字「${clean}」提供 JSON：{"pos":"詞性","phonetic":"音標/讀音","meaning":"簡明繁體中文釋義","sentence":"自然例句","translation":"例句翻譯"}`, { feature: 'def_fill' });
                const m = String(raw || '').match(/\{[\s\S]*\}/);
                if (m) filled = JSON.parse(m[0]);
            }
            if (filled && (filled.meaning || filled.pos || filled.sentence)) {
                globalWordAiResult = {
                    word: clean,
                    pos: filled.pos || '',
                    phonetic: filled.phonetic || '',
                    meaning: filled.meaning || '',
                    sentence: filled.sentence || '',
                    translation: filled.translation || ''
                };
            } else if (typeof showToast === 'function') {
                showToast('AI 未回傳有效解釋，請重試', 'warning');
            }
        } catch (err) {
            if (typeof showToast === 'function') showToast(`查詢失敗：${err.message}`, 'error');
        } finally {
            isGlobalSearchAiBusy = false;
            renderWordManagerDrawer();
        }
    }

    function quickAddSearchedWord(idx, source) {
        let item = null;
        if (source === 'ai') {
            item = globalWordAiResult;
        } else {
            const { vocabHits } = buildGlobalSearchResults(globalWordSearchText);
            item = vocabHits[idx] || null;
        }
        if (!item || !item.word) return false;

        const defaultCat = (typeof global.t === 'function' && global.t('defaultCategoryName') !== 'defaultCategoryName')
            ? global.t('defaultCategoryName')
            : '預設字庫';
        const activeCats = Array.isArray(global.selectedCategories) ? global.selectedCategories : ['ALL'];
        const targetCat = (activeCats.length === 1 && activeCats[0] !== 'ALL') ? activeCats[0] : defaultCat;

        const word = String(item.word).trim();
        const cardId = typeof global.generateDeterministicCardId === 'function'
            ? global.generateDeterministicCardId(targetCat, word)
            : ('w_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
        const deckId = typeof global.generateDeterministicDeckId === 'function'
            ? global.generateDeterministicDeckId(targetCat)
            : undefined;

        const list = Array.isArray(global.wordList) ? global.wordList : [];
        const dup = list.some(w => w && String(w.word || '').trim().toLowerCase() === word.toLowerCase() && String(w.category || defaultCat).trim() === targetCat);
        if (dup) {
            if (typeof showToast === 'function') showToast(`「${word}」已存在於字庫「${targetCat}」！`, 'info');
            return false;
        }

        const now = Date.now();
        list.unshift({
            id: cardId,
            deckId,
            category: targetCat,
            word,
            pos: String(item.pos || '').trim(),
            phonetic: String(item.phonetic || '').trim(),
            meaning: String(item.meaning || '無釋義').trim(),
            sentence: String(item.sentence || '').trim(),
            translation: String(item.translation || '').trim(),
            level: 1,
            knowStreak: 0,
            state: 'new',
            stability: 0,
            difficulty: 5.5,
            reps: 0,
            lapses: 0,
            lastReview: 0,
            nextReview: 0,
            freeLevel: 1,
            freeStreak: 0,
            updatedAt: now
        });

        if (typeof global.autoDeduplicateWordList === 'function') global.autoDeduplicateWordList({ silent: true });
        if (typeof global.saveStorage === 'function') global.saveStorage();
        if (typeof global.updateCategorySelects === 'function') global.updateCategorySelects();
        if (typeof global.updateUI === 'function') global.updateUI();
        if (typeof showToast === 'function') showToast(`✅ 已將「${word}」加入字庫「${targetCat}」！`, 'success');
        renderWordManagerDrawer();
        return true;
    }

    const MorphologyEngine = {
        PREFIXES,
        ROOTS,
        SUFFIXES,
        ALL_MORPHEMES,
        isEnabled,
        setEnabled,
        shouldHighlightCardWord,
        analyzeWordMorphemes,
        renderInteractiveCardWordHtml,
        showSegmentPopover,
        hideSegmentPopover,
        openWordManagerDrawer,
        closeWordManagerDrawer,
        switchDrawerTab,
        onMorphFilterInput,
        clearMorphAiHistory,
        askAiFollowUpForMorpheme,
        submitMorphAiQuestion,
        askAiAboutText,
        onGlobalWordSearchInput,
        lookupWordWithAi,
        quickAddSearchedWord,
        buildGlobalSearchResults
    };

    global.MorphologyEngine = MorphologyEngine;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = MorphologyEngine;
    }
})(typeof window !== 'undefined' ? window : globalThis);
