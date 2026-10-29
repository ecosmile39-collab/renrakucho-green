// 文章を書く欄に「定型文を選ぶ」プルダウンを付ける。
// 選んだ文は欄の最後に追記され、そのあと自由に書き足せる（ショートステイの夜間・日中欄と同じ動き）。
// services を指定した文は、そのサービスのときだけ候補に出す。

const AFTER_SCHOOL = "放課後等デイサービス";
const EARLY_CHILDHOOD = "児童発達支援";

const bathNote = [
    "一般浴にて入浴され、さっぱりされました。",
    "機械浴にて入浴され、気持ちよさそうにされていました。",
    "ご本人の希望により、本日は入浴を見合わせました。",
    "体調を考慮し、清拭で対応しました。"
];

const sleep = [
    "21時頃に就寝、6時頃に起床されました。夜間は良眠されていました。",
    "夜間にトイレで1回起きられましたが、その後は再入眠されました。",
    "寝つきが悪く、夜間に何度か目を覚まされました。",
    "夜間の巡視時はよくお休みでした。"
];

const supplies = (place) => [
    "日用品の補充は、今のところ必要ありません。",
    "ティッシュの残りが少なくなっています。補充をお願いします。",
    "歯磨き粉の補充をお願いします。",
    "おむつ（パッド）の残りが少なくなっています。補充をお願いします。",
    `季節の衣類の入れ替えについて、${place}までご相談ください。`
];

const belongings = [
    "本日、新しくお預かりした物品はありません。",
    "衣類をお預かりし、記名を確認しました。",
    "記名のない衣類がありました。お手数ですが記名をお願いします。"
];

export const SENTENCE_TEMPLATES = {
    // 介護日誌（デイサービス・ショートステイ・入所・グループホームなど共通）
    careJournal: [
        "本日も大きな体調の変化はなく、穏やかに過ごされた。",
        "来所時のバイタルは安定。午前の体操に参加された。",
        "入浴は一般浴にて実施。皮膚の状態に特変なし。",
        "昼食は全量摂取。食事中のむせ込みなし。",
        "水分摂取が少なめのため、こまめに声かけを行った。",
        "トイレ誘導を行い、排泄の失敗なし。",
        "歩行時にふらつきが見られたため、見守りを強化した。",
        "午後はレクリエーションに参加され、笑顔が多く見られた。",
        "帰宅願望が見られたが、声かけと傾聴で落ち着かれた。",
        "送迎時、ご家族より体調について連絡あり。内容を申し送った。",
        "特記事項なし。"
    ],

    // 放課後等デイサービス・児童発達支援
    afterSchoolSupport: [
        { text: "宿題に取り組み、最後までやり遂げました。", services: [AFTER_SCHOOL] },
        { text: "SST（ソーシャルスキルトレーニング）で、順番を待つ練習をしました。", services: [AFTER_SCHOOL] },
        { text: "感覚あそび（粘土・スライム）を楽しみました。", services: [EARLY_CHILDHOOD] },
        { text: "着替えや手洗いの練習をしました。", services: [EARLY_CHILDHOOD] },
        { text: "絵本の読み聞かせを楽しみました。", services: [EARLY_CHILDHOOD] },
        "公園で体を動かして遊びました。",
        "工作に取り組み、作品を完成させました。",
        "リズム体操・音楽あそびで体を動かしました。",
        "個別課題（パズル・ひも通し）に取り組みました。"
    ],
    afterSchoolEpisode: [
        "笑顔で活動に参加し、楽しそうに過ごしていました。",
        "お友だちと順番を守って遊ぶことができました。",
        "最初は緊張していましたが、少しずつ慣れて参加できました。",
        "自分から「やりたい」と伝えることができました。",
        "気持ちが落ち着かない場面もありましたが、声かけで切り替えることができました。",
        "大きな怪我や体調の変化はありませんでした。"
    ],
    afterSchoolHandoverNote: [
        "特記事項なし。",
        "体調面の様子見をお願いします。",
        "保護者より連絡あり。内容を確認してください。"
    ],

    // 生活介護
    lifeCareHealthNote: [
        "体調に大きな変化はありませんでした。",
        "来所時はやや疲れた様子でしたが、休憩後は元気に過ごされました。",
        "咳・鼻水が少し見られました。",
        "血圧がやや高めでしたが、再測定で落ち着いています。"
    ],
    lifeCareGoalProgress: [
        "目標に沿って、ご自身で準備を行うことができました。",
        "声かけにより、最後まで取り組むことができました。",
        "前回よりもスムーズにできるようになっています。",
        "本日は意欲が低めでしたが、一部参加することができました。"
    ],
    lifeCareActivityDetails: [
        "創作活動で塗り絵に取り組まれました。",
        "軽作業（袋詰め）に集中して取り組まれました。",
        "体操やストレッチで体を動かされました。",
        "散歩に出かけ、季節の風景を楽しまれました。",
        "音楽に合わせて手拍子をされ、楽しまれていました。"
    ],
    lifeCareEpisode: [
        "笑顔が多く、穏やかに過ごされました。",
        "他の利用者様との会話を楽しまれていました。",
        "ご自身で活動を選んで参加されました。",
        "落ち着かない場面もありましたが、声かけで穏やかになられました。",
        "事故や大きな体調の変化はありませんでした。"
    ],
    lifeCareStaffHandoverNote: [
        "特記事項なし。",
        "体調面の観察を継続してください。",
        "ご家族より連絡あり。内容を確認してください。"
    ],
    lifeCareHandover: [
        "本日も元気に過ごされました。",
        "次回、着替えを1組お持ちください。",
        "水分が少なめでしたので、ご自宅でも水分補給をお願いします。",
        "体調の変化がありましたら、施設までご連絡ください。"
    ],

    // グループホーム
    ghBathNote: bathNote,
    ghSleep: sleep,
    ghRoles: [
        "洗濯物たたみを一緒に行いました。",
        "食事の配膳・下膳を手伝っていただきました。",
        "簡単な調理（野菜の皮むき）を一緒に行いました。",
        "植物の水やりを担当していただきました。"
    ],
    ghRoleResponse: [
        "丁寧に取り組まれ、笑顔が見られました。",
        "声かけで取り組みを始められ、最後まで行えました。",
        "手順を覚えておられ、ほぼお一人でできました。"
    ],
    ghDailyLife: [
        "リビングで他の入居者様と談笑され、穏やかに過ごされました。",
        "職員と近所を散歩され、季節の花を楽しまれました。",
        "テレビや歌を楽しまれ、ゆったりと過ごされました。",
        "お部屋でご自身のペースで過ごされました。"
    ],
    ghSupplies: supplies("ホーム"),
    ghBelongings: belongings,

    // 入所・ユニット入所
    rsBathNote: bathNote,
    rsSleep: sleep,
    rsDailyActivity: [
        "体操に参加され、しっかり体を動かされました。",
        "塗り絵や脳トレに取り組まれました。",
        "ユニットで洗濯物たたみを手伝っていただきました。",
        "レクリエーションに参加され、楽しまれていました。"
    ],
    rsDailyState: [
        "他のご入所者様と談笑され、笑顔が多く見られました。",
        "終日、穏やかに過ごされました。",
        "少し元気がない様子でしたが、声かけで笑顔が見られました。"
    ],
    rsSupplies: supplies("施設"),
    rsBelongings: belongings,
    rsVisit: [
        "本日、面会・外出はありませんでした。",
        "ご家族様が面会に来られ、楽しそうにお話しされていました。",
        "ご家族様と外出され、夕方に帰設されました。"
    ]
};

export function templatesFor(fieldId, serviceType) {
    return (SENTENCE_TEMPLATES[fieldId] || [])
        .map(item => typeof item === "string" ? { text: item } : item)
        .filter(item => !item.services || item.services.includes(serviceType))
        .map(item => item.text);
}

export function appendTemplateText(currentValue, text) {
    if (!text) return currentValue;
    return currentValue ? `${currentValue}\n${text}` : text;
}

// 対象の欄の直前に「定型文を選ぶ」プルダウンを置き、サービスに合わせて候補を入れ替える
export function setupSentenceTemplates(document, serviceType) {
    for (const fieldId of Object.keys(SENTENCE_TEMPLATES)) {
        const target = document.getElementById(fieldId);
        if (!target) continue;
        let select = target.previousElementSibling;
        if (!select || !select.classList.contains("sentence-template")) {
            select = document.createElement("select");
            select.className = "sentence-template";
            select.dataset.target = fieldId;
            select.style.marginBottom = "8px";
            select.addEventListener("change", () => {
                if (!select.value) return;
                target.value = appendTemplateText(target.value, select.value);
                select.value = "";
                target.dispatchEvent(new Event("input", { bubbles: true }));
            });
            target.before(select);
        }
        const texts = templatesFor(fieldId, serviceType);
        select.replaceChildren();
        select.add(new Option("📝 定型文を選ぶ（選んだ後、自由に追記できます）", ""));
        texts.forEach((text, index) => select.add(new Option(`${index + 1}. ${text}`, text)));
    }
}
