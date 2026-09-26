// 離子麻將核心規則模組 (純邏輯、無 DOM、無 Socket)

const CATIONS = {
    "Na+": 1, "K+": 1, "H+": 1, "NH4+": 1,
    "Ca2+": 2, "Mg2+": 2, "Ba2+": 2,
    "Al3+": 3, "Fe3+": 3
};

const ANIONS = {
    "Cl-": 1, "OH-": 1, "NO3-": 1, "CH3COO-": 1,
    "O2-": 2, "SO42-": 2, "CO32-": 2,
    "PO43-": 3, "N3-": 3
};

const COEFFS = {
    "1": 16, "2": 12, "3": 8, "4": 4
};

const ION_DISPLAY_MAP = {
    "Na+": "Na⁺", "K+": "K⁺", "H+": "H⁺", "NH4+": "NH₄⁺",
    "Ca2+": "Ca²⁺", "Mg2+": "Mg²⁺", "Ba2+": "Ba²⁺", "Al3+": "Al³⁺", "Fe3+": "Fe³⁺",
    "Cl-": "Cl⁻", "OH-": "OH⁻", "NO3-": "NO₃⁻", "CH3COO-": "CH₃COO⁻",
    "O2-": "O²⁻", "SO42-": "SO₄²⁻", "CO32-": "CO₃²⁻", "PO43-": "PO₄³⁻", "N3-": "N³⁻"
};

// 產生完整 112 張牌庫
function buildDeck() {
    const deck = [];
    let idCounter = 0;

    for (const [ion, val] of Object.entries(CATIONS)) {
        for (let i = 0; i < 4; i++) {
            deck.push({ id: ++idCounter, text: ion, type: 'cation', val });
        }
    }
    for (const [ion, val] of Object.entries(ANIONS)) {
        for (let i = 0; i < 4; i++) {
            deck.push({ id: ++idCounter, text: ion, type: 'anion', val });
        }
    }
    for (const [coeff, count] of Object.entries(COEFFS)) {
        for (let i = 0; i < count; i++) {
            deck.push({ id: ++idCounter, text: coeff, type: 'coeff', val: parseInt(coeff, 10) });
        }
    }
    return deck;
}

// 洗牌 (Fisher-Yates)
function shuffleDeck(deck) {
    const d = [...deck];
    for (let i = d.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
}

// 驗證單一組合是否電中性，若成立回傳轉移之價電子數 (電荷量)，不成立回傳 0
function getSetCharge(tiles) {
    if (!tiles || tiles.length < 2 || tiles.length > 4) return 0;

    const cats = tiles.filter(t => t.type === 'cation');
    const ans = tiles.filter(t => t.type === 'anion');
    const cofs = tiles.filter(t => t.type === 'coeff');

    // 必須且只能有一張陽離子、一張陰離子
    if (cats.length !== 1 || ans.length !== 1) return 0;

    const cVal = cats[0].val;
    const aVal = ans[0].val;

    if (cofs.length === 0) {
        return cVal === aVal ? cVal : 0;
    }

    if (cofs.length === 1) {
        if (cofs[0].val * cVal === aVal) return aVal;
        if (cVal === cofs[0].val * aVal) return cVal;
        return 0;
    }

    if (cofs.length === 2) {
        if (cofs[0].val * cVal === cofs[1].val * aVal) return cofs[0].val * cVal;
        if (cofs[1].val * cVal === cofs[0].val * aVal) return cofs[1].val * cVal;
        return 0;
    }

    return 0;
}

function isValidSet(tiles) {
    return getSetCharge(tiles) > 0;
}

// 化學教學加番判定 (沉澱反應 +5、酸鹼中和 +3)
function getSetSpecialBonus(tiles) {
    const charge = getSetCharge(tiles);
    if (charge <= 0) return { bonus: 0, tag: null };

    const cat = tiles.find(t => t.type === 'cation');
    const an = tiles.find(t => t.type === 'anion');
    if (!cat || !an) return { bonus: 0, tag: null };

    // 酸鹼中和反應：H+ + OH- -> H2O (+3 分)
    if (cat.text === 'H+' && an.text === 'OH-') {
        return { bonus: 3, tag: '酸鹼中和 H₂O (+3)' };
    }

    // 沉澱反應：常見難溶鹽 (+5 分)
    const pair = `${cat.text}+${an.text}`;
    const PRECIPITATES = {
        'Ba2++SO42-': '硫酸鋇白色沉澱 BaSO₄ (+5)',
        'Ca2++CO32-': '碳酸鈣白色沉澱 CaCO₃ (+5)',
        'Ba2++CO32-': '碳酸鋇白色沉澱 BaCO₃ (+5)',
        'Mg2++OH-': '氫氧化鎂沉澱 Mg(OH)₂ (+5)',
        'Fe3++OH-': '氫氧化鐵紅褐色沉澱 Fe(OH)₃ (+5)',
        'Al3++OH-': '氫氧化鋁膠狀沉澱 Al(OH)₃ (+5)'
    };

    if (PRECIPITATES[pair]) {
        return { bonus: 5, tag: PRECIPITATES[pair] };
    }

    return { bonus: 0, tag: null };
}

// 記憶化計算手牌最大分數 (若無法完全拆成中性組則回傳 -1)
function getMaxHandScore(arr, memo = new Map()) {
    if (!arr || arr.length === 0) return 0;

    // 快取 key: 將 card id 遞增排序
    const key = arr.map(t => t.id).sort((a, b) => a - b).join(',');
    if (memo.has(key)) return memo.get(key);

    const first = arr[0];
    const rest = arr.slice(1);
    let maxScore = -1;

    // 1. 嘗試組合 2 張 (first + 1張)
    for (let i = 0; i < rest.length; i++) {
        const charge = getSetCharge([first, rest[i]]);
        if (charge > 0) {
            const nextArr = rest.filter((_, idx) => idx !== i);
            const subScore = getMaxHandScore(nextArr, memo);
            if (subScore !== -1) {
                const total = charge + subScore;
                if (total > maxScore) maxScore = total;
            }
        }
    }

    // 2. 嘗試組合 3 張 (first + 2張)
    for (let i = 0; i < rest.length; i++) {
        for (let j = i + 1; j < rest.length; j++) {
            const charge = getSetCharge([first, rest[i], rest[j]]);
            if (charge > 0) {
                const nextArr = rest.filter((_, idx) => idx !== i && idx !== j);
                const subScore = getMaxHandScore(nextArr, memo);
                if (subScore !== -1) {
                    const total = charge + subScore;
                    if (total > maxScore) maxScore = total;
                }
            }
        }
    }

    // 3. 嘗試組合 4 張 (first + 3張)
    for (let i = 0; i < rest.length; i++) {
        for (let j = i + 1; j < rest.length; j++) {
            for (let k = j + 1; k < rest.length; k++) {
                const charge = getSetCharge([first, rest[i], rest[j], rest[k]]);
                if (charge > 0) {
                    const nextArr = rest.filter((_, idx) => idx !== i && idx !== j && idx !== k);
                    const subScore = getMaxHandScore(nextArr, memo);
                    if (subScore !== -1) {
                        const total = charge + subScore;
                        if (total > maxScore) maxScore = total;
                    }
                }
            }
        }
    }

    memo.set(key, maxScore);
    return maxScore;
}

// 判定手牌是否能完全胡牌
function canPartition(hand) {
    return getMaxHandScore(hand) !== -1;
}

// 計算手牌相鄰可配對的提示索引 (前端輔助高亮用)
function getValidSetIndices(hand) {
    const validIndices = new Set();
    let i = 0;
    while (i < hand.length) {
        let found = false;
        for (let k = 4; k >= 2; k--) {
            if (i + k <= hand.length) {
                const subset = hand.slice(i, i + k);
                if (isValidSet(subset)) {
                    for (let j = 0; j < k; j++) validIndices.add(i + j);
                    i += k;
                    found = true;
                    break;
                }
            }
        }
        if (!found) i++;
    }
    return Array.from(validIndices);
}

// 計算可與 targetCard 搭配的吃牌組合 (在手牌中挑選 1~3 張與其湊成電中性)
function getEatCombos(hand, targetCard) {
    const combos = [];
    const len = hand.length;

    // 配 1 張
    for (let i = 0; i < len; i++) {
        if (isValidSet([targetCard, hand[i]])) {
            combos.push([hand[i]]);
        }
    }
    // 配 2 張
    for (let i = 0; i < len; i++) {
        for (let j = i + 1; j < len; j++) {
            if (isValidSet([targetCard, hand[i], hand[j]])) {
                combos.push([hand[i], hand[j]]);
            }
        }
    }
    // 配 3 張
    for (let i = 0; i < len; i++) {
        for (let j = i + 1; j < len; j++) {
            for (let k = j + 1; k < len; k++) {
                if (isValidSet([targetCard, hand[i], hand[j], hand[k]])) {
                    combos.push([hand[i], hand[j], hand[k]]);
                }
            }
        }
    }

    // 依卡片 ID 去重組合
    const uniqueCombos = [];
    const seen = new Set();
    for (const c of combos) {
        const sortedIds = c.map(x => x.id).sort((a,b)=>a-b).join('-');
        if (!seen.has(sortedIds)) {
            seen.add(sortedIds);
            uniqueCombos.push(c);
        }
    }
    return uniqueCombos;
}

// 計算整局得點：基礎手牌電荷 + 外露組合電荷 + 化學特殊加番
function calculateScoreBreakdown(hand, exposed) {
    const baseHandCharge = Math.max(0, getMaxHandScore(hand));
    let baseExposedCharge = 0;
    const bonusTags = [];
    let totalBonus = 0;

    // 檢查外露組合
    for (const set of exposed) {
        const c = getSetCharge(set);
        baseExposedCharge += c;
        const b = getSetSpecialBonus(set);
        if (b.bonus > 0) {
            totalBonus += b.bonus;
            bonusTags.push(b.tag);
        }
    }

    // 檢查暗牌中可能包含的特殊組合
    // (以貪婪法拆解手牌中的合法組以標記化學加成)
    const remaining = [...hand];
    while (remaining.length >= 2) {
        let matched = false;
        for (let k = 4; k >= 2; k--) {
            // 尋找一個合法組
            const subset = remaining.slice(0, k);
            if (isValidSet(subset)) {
                const b = getSetSpecialBonus(subset);
                if (b.bonus > 0) {
                    totalBonus += b.bonus;
                    bonusTags.push(b.tag);
                }
                remaining.splice(0, k);
                matched = true;
                break;
            }
        }
        if (!matched) {
            remaining.shift();
        }
    }

    const totalCharge = baseHandCharge + baseExposedCharge;
    const finalScore = totalCharge + totalBonus;

    return {
        baseHandCharge,
        baseExposedCharge,
        totalCharge,
        totalBonus,
        bonusTags,
        finalScore
    };
}

module.exports = {
    CATIONS,
    ANIONS,
    COEFFS,
    ION_DISPLAY_MAP,
    buildDeck,
    shuffleDeck,
    getSetCharge,
    isValidSet,
    getSetSpecialBonus,
    getMaxHandScore,
    canPartition,
    getValidSetIndices,
    getEatCombos,
    calculateScoreBreakdown
};
