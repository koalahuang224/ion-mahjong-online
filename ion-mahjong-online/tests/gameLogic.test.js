const assert = require('assert');
const logic = require('../logic/gameLogic');

console.log('--- 測試 1: 牌庫建置與張數驗證 ---');
const deck = logic.buildDeck();
assert.strictEqual(deck.length, 112, '牌庫總數應為 112 張');
console.log('✓ 牌庫總數正確：112 張');

console.log('--- 測試 2: 電中性判斷 ---');
// Na+ (1) + Cl- (1) -> 有效 (電荷 1)
const setNaCl = [
    { id: 1, text: 'Na+', type: 'cation', val: 1 },
    { id: 2, text: 'Cl-', type: 'anion', val: 1 }
];
assert.strictEqual(logic.getSetCharge(setNaCl), 1, 'NaCl 應為電荷 1');

// Ca2+ (2) + Cl- (1) + 2 (係數) -> 有效 (電荷 2)
const setCaCl2 = [
    { id: 3, text: 'Ca2+', type: 'cation', val: 2 },
    { id: 4, text: 'Cl-', type: 'anion', val: 1 },
    { id: 5, text: '2', type: 'coeff', val: 2 }
];
assert.strictEqual(logic.getSetCharge(setCaCl2), 2, 'CaCl2 應為電荷 2');

// Al3+ (3) + O2- (2) + 2 (係數) + 3 (係數) -> 有效 (電荷 6)
const setAl2O3 = [
    { id: 6, text: 'Al3+', type: 'cation', val: 3 },
    { id: 7, text: 'O2-', type: 'anion', val: 2 },
    { id: 8, text: '2', type: 'coeff', val: 2 },
    { id: 9, text: '3', type: 'coeff', val: 3 }
];
assert.strictEqual(logic.getSetCharge(setAl2O3), 6, 'Al2O3 應為電荷 6');

// 無效組合: 兩個陽離子
const setInvalid = [
    { id: 10, text: 'Na+', type: 'cation', val: 1 },
    { id: 11, text: 'K+', type: 'cation', val: 1 }
];
assert.strictEqual(logic.getSetCharge(setInvalid), 0, '雙陽離子應不合法 (電荷 0)');
console.log('✓ 電中性組合判斷正確');

console.log('--- 測試 3: 化學加番判定 ---');
const setBaSO4 = [
    { id: 12, text: 'Ba2+', type: 'cation', val: 2 },
    { id: 13, text: 'SO42-', type: 'anion', val: 2 }
];
const bonusBaSO4 = logic.getSetSpecialBonus(setBaSO4);
assert.strictEqual(bonusBaSO4.bonus, 5, 'BaSO4 應獲得沉澱加番 5 點');
assert.ok(bonusBaSO4.tag.includes('硫酸鋇'), '標籤應包含硫酸鋇');

const setNeutralWater = [
    { id: 14, text: 'H+', type: 'cation', val: 1 },
    { id: 15, text: 'OH-', type: 'anion', val: 1 }
];
const bonusH2O = logic.getSetSpecialBonus(setNeutralWater);
assert.strictEqual(bonusH2O.bonus, 3, 'H+ + OH- 應獲得中和加番 3 點');
console.log('✓ 化學加番判定正確');

console.log('--- 測試 4: 手牌拆分與胡牌判定 (Memoized getMaxHandScore) ---');
// 組合 4 張牌可完全配對
const hand4 = [...setNaCl, ...setCaCl2];
assert.strictEqual(logic.canPartition(hand4), true, 'hand4 應可完全配對');
assert.strictEqual(logic.getMaxHandScore(hand4), 3, ' hand4 總分應為 1 + 2 = 3');

// 隨機單張無效牌
const handInvalid = [...hand4, { id: 99, text: 'Al3+', type: 'cation', val: 3 }];
assert.strictEqual(logic.canPartition(handInvalid), false, '多出一張不可配對的牌時應無法胡牌');
console.log('✓ 記憶化手牌拆分與胡牌判定正確');

console.log('--- 測試 5: 吃牌組合判定 ---');
const handToEat = [
    { id: 20, text: 'Cl-', type: 'anion', val: 1 },
    { id: 21, text: '2', type: 'coeff', val: 2 },
    { id: 22, text: 'SO42-', type: 'anion', val: 2 }
];
const targetCard = { id: 23, text: 'Ca2+', type: 'cation', val: 2 };
const combos = logic.getEatCombos(handToEat, targetCard);
// Ca2+ 可以和 SO42- 配成一組 (1張)，或和 Cl- + 2 配成一組 (2張)
assert.strictEqual(combos.length, 2, '應有 2 種吃牌組合');
console.log('✓ 吃牌候選組合計算正確');

console.log('\n>>> 全部核心邏輯單元測試通過！<<<');
