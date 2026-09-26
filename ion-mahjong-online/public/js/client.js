
// 背景音樂自動播放與切換控制器
function tryPlayBGM() {
    const bgm = document.getElementById('bgm');
    const musicBtn = document.getElementById('music-toggle');
    if (bgm && bgm.paused) {
        bgm.volume = 0.3;
        bgm.play().then(() => {
            if (musicBtn) musicBtn.innerText = '🔊 音樂：開';
        }).catch(() => {
            // 瀏覽器 Autoplay 政策限制時保持關閉，等待使用者點擊按鈕
        });
    }
}
// 離子麻將客戶端主邏輯 (第 14 章視覺與操作優化版)
let socket = null;
let currentRoomId = null;
let myPlayerId = null;
let myReconnectToken = null;
let mySeat = 0;
let currentState = null;
let selectedCardId = null;
let timerInterval = null;
let handSortOrder = 'TYPE'; // 'TYPE' 或 'ORIGINAL'
let handOrderIds = [];
let draggedCardId = null;
let suppressCardClick = false;
let claimSelectionMode = false;
let claimSelectedCardIds = [];

const ION_DISPLAY_MAP = {
    "Na+": "Na⁺", "K+": "K⁺", "H+": "H⁺", "NH4+": "NH₄⁺",
    "Ca2+": "Ca²⁺", "Mg2+": "Mg²⁺", "Ba2+": "Ba²⁺", "Al3+": "Al³⁺", "Fe3+": "Fe³⁺",
    "Cl-": "Cl⁻", "OH-": "OH⁻", "NO3-": "NO₃⁻", "CH3COO-": "CH₃COO⁻",
    "O2-": "O²⁻", "SO42-": "SO₄²⁻", "CO32-": "CO₃²⁻", "PO43-": "PO₄³⁻", "N3-": "N³⁻"
};

// 視窗等比自適應縮放 (1280x720)
function autoResize() {
    const board = document.getElementById('game-board');
    if (!board) return;
    const baseW = 1280;
    const baseH = 720;
    const scale = Math.min(window.innerWidth / baseW, window.innerHeight / baseH);
    board.style.transform = `scale(${scale})`;
}
window.addEventListener('resize', autoResize);
window.addEventListener('DOMContentLoaded', () => {
    autoResize();
    initApp();
});

function generateActionId() {
    return `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

function initApp() {
    socket = io();

    // 檢查網址參數帶房號
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam) {
        document.getElementById('room-code-input').value = roomParam;
    }

    // 檢查 sessionStorage 重連
    const savedRoomId = sessionStorage.getItem('ion_room_id');
    const savedToken = sessionStorage.getItem('ion_reconnect_token');
    if (savedRoomId && savedToken) {
        socket.emit('join_room', {
            roomId: savedRoomId,
            playerName: '重連中...',
            reconnectToken: savedToken
        });
    }

    // 按鈕綁定
    document.getElementById('create-room-btn').onclick = () => {
        const name = document.getElementById('player-name-input').value.trim() || '房主';
        socket.emit('create_room', { playerName: name }); tryPlayBGM();
    };

    document.getElementById('join-room-btn').onclick = () => {
        const name = document.getElementById('player-name-input').value.trim() || '玩家';
        const code = document.getElementById('room-code-input').value.trim();
        if (!code || code.length < 4) {
            alert('請輸入正確的房號！');
            return;
        }
        socket.emit('join_room', { roomId: code, playerName: name }); tryPlayBGM();
    };

    document.getElementById('copy-link-btn').onclick = () => {
        if (!currentRoomId) return;
        const link = `${window.location.origin}${window.location.pathname}?room=${currentRoomId}`;
        navigator.clipboard.writeText(link).then(() => {
            alert(`已複製邀請連結：\n${link}\n將此連結傳給朋友即可直接加入！`);
        }).catch(() => {
            alert(`房號為：${currentRoomId}`);
        });
    };

    document.getElementById('add-bot-btn').onclick = () => {
        socket.emit('add_bot');
    };

    document.getElementById('start-game-btn').onclick = () => {
        socket.emit('start_game'); tryPlayBGM();
    };

    document.getElementById('sort-hand-btn').onclick = () => {
        sortMyHand();
        renderMyHand();
    };

    document.getElementById('score-next-btn').onclick = () => {
        socket.emit('action', { type: 'NEXT_ROUND', actionId: generateActionId() });
    };

    document.getElementById('rules-btn').onclick = () => {
        document.getElementById('rules-modal').style.display = 'flex';
    };
    document.getElementById('close-rules-btn').onclick = () => {
        document.getElementById('rules-modal').style.display = 'none';
    };

    // 音樂開關
    const bgm = document.getElementById('bgm');
    const musicBtn = document.getElementById('music-toggle');
    musicBtn.onclick = () => {
        if (bgm.paused) {
            bgm.volume = 0.35;
            bgm.play().then(() => {
                musicBtn.innerText = '🔊 音樂：開';
            }).catch(() => {});
        } else {
            bgm.pause();
            musicBtn.innerText = '🔈 音樂：關';
        }
    };

    // Socket 事件監聽
    socket.on('error_alert', (msg) => {
        alert(msg);
    });

    socket.on('room_created', (data) => {
        handleJoinSuccess(data);
    });

    socket.on('join_success', (data) => {
        handleJoinSuccess(data);
    });

    socket.on('reconnect_success', (data) => {
        handleJoinSuccess(data);
    });

    socket.on('state_sync', (state) => {
        if (state.phase !== 'CLAIM_WINDOW') {
            claimSelectionMode = false;
            claimSelectedCardIds = [];
        }
        currentState = state;
        mySeat = state.mySeat;
        currentRoomId = state.roomId;
        renderAll();
    });
}

function handleJoinSuccess(data) {
    currentRoomId = data.roomId;
    myPlayerId = data.playerId;
    myReconnectToken = data.reconnectToken || myReconnectToken;
    mySeat = data.seat;
    sessionStorage.setItem('ion_room_id', currentRoomId);
    if (myReconnectToken) {
        sessionStorage.setItem('ion_reconnect_token', myReconnectToken);
    }
    document.getElementById('toolbar-room-id').innerText = currentRoomId;
    document.getElementById('display-room-id').innerText = currentRoomId;
    document.getElementById('copy-link-btn').style.display = 'inline-block';
}

// 手牌穩定排序 (陽離子 -> 陰離子 -> 係數牌)
function sortMyHand() {
    if (!currentState || !currentState.myHand) return;
    const typePriority = { 'cation': 1, 'anion': 2, 'coeff': 3 };
    handOrderIds = [...currentState.myHand].sort((a, b) => {
        if (typePriority[a.type] !== typePriority[b.type]) {
            return typePriority[a.type] - typePriority[b.type];
        }
        if (a.val !== b.val) {
            return b.val - a.val;
        }
        return a.text.localeCompare(b.text);
    }).map(card => card.id);
}

function getOrderedMyHand() {
    const hand = currentState?.myHand || [];
    const idsInHand = new Set(hand.map(card => card.id));
    handOrderIds = handOrderIds.filter(id => idsInHand.has(id));
    const knownIds = new Set(handOrderIds);
    hand.forEach(card => {
        if (!knownIds.has(card.id)) handOrderIds.push(card.id);
    });
    const cardsById = new Map(hand.map(card => [card.id, card]));
    return handOrderIds.map(id => cardsById.get(id)).filter(Boolean);
}

function moveHandCard(sourceId, targetId) {
    if (sourceId === targetId) return;
    getOrderedMyHand();
    const sourceIndex = handOrderIds.indexOf(sourceId);
    if (sourceIndex < 0 || handOrderIds.indexOf(targetId) < 0) return;
    handOrderIds.splice(sourceIndex, 1);
    const targetIndex = handOrderIds.indexOf(targetId);
    handOrderIds.splice(targetIndex, 0, sourceId);
    selectedCardId = null;
    renderMyHand();
}

// 畫面總渲染器
function renderAll() {
    if (!currentState) return;

    const lobbyScreen = document.getElementById('lobby-screen');
    const waitingScreen = document.getElementById('waiting-screen');
    const scoreModal = document.getElementById('score-modal');

    // 1. 等待室/大廳管理
    if (currentState.status === 'WAITING') {
        lobbyScreen.style.display = 'none';
        waitingScreen.style.display = 'flex';
        document.getElementById('status-badge').innerText = '狀態：等待中';
        renderWaitingSeats();
        return;
    } else {
        lobbyScreen.style.display = 'none';
        waitingScreen.style.display = 'none';
        document.getElementById('status-badge').innerText = `狀態：第 ${currentState.version} 手`; tryPlayBGM();
    const roundBadge = document.getElementById('round-badge');
    if (roundBadge && (currentState.roundNo || currentState.roundNumber)) {
        const rNo = currentState.roundNo || currentState.roundNumber || 1;
        const maxR = currentState.maxRounds || currentState.totalRounds || 4;
        roundBadge.innerText = `第 ${rNo} / ${maxR} 局`;
    }
    }

    // 2. 結算彈窗
    if (currentState.status === 'ROUND_OVER') {
        renderSettlement();
    } else {
        scoreModal.style.display = 'none';
    }

    // 3. 中央主戰場狀態
    renderCenterBattleground();

    // 4. 三方座位 (對家、左家、右家)
    renderOpponentsSeats();

    // 5. 底部自己的資訊、手牌與操作列
    renderBottomMyArea();
}

// 渲染等待室座位
function renderWaitingSeats() {
    const container = document.getElementById('waiting-seats-container');
    container.innerHTML = '';

    const isHost = currentState.players.some(p => p.seat === mySeat && p.isHost);
    document.getElementById('add-bot-btn').style.display = (isHost && currentState.players.length < 4) ? 'inline-block' : 'none';
    document.getElementById('start-game-btn').style.display = (isHost && currentState.players.length === 4) ? 'inline-block' : 'none';

    for (let i = 0; i < 4; i++) {
        const p = currentState.players[i];
        const card = document.createElement('div');
        card.className = `seat-card ${p ? 'active' : ''}`;

        if (p) {
            const avatar = p.isBot ? '🤖' : (p.isHost ? '👑' : '👤');
            card.innerHTML = `
                <div class="seat-avatar">${avatar}</div>
                <div class="seat-name">${p.name} ${p.seat === mySeat ? '(您)' : ''}</div>
                <div class="seat-status">${p.isAiTakeover ? '🤖 AI 託管中' : (p.isConnected ? '已就緒' : '斷線中')}</div>
            `;
        } else {
            card.innerHTML = `
                <div class="seat-avatar">🪑</div>
                <div class="seat-name" style="color: #888;">第 ${i + 1} 位</div>
                <div class="seat-status" style="color: #777;">等待加入</div>
            `;
        }
        container.appendChild(card);
    }
}

// 相對座位換算公式 (1: 自己, 2: 下家右, 3: 對加上, 4: 上家左)
function getDomPlayerIndex(targetSeat, mySeat) {
    const relativeOffset = (targetSeat - mySeat + 4) % 4;
    return relativeOffset + 1;
}

// 渲染中央主戰場 (最新棄牌聚焦槽 + 歷史網格)
function renderCenterBattleground() {
    const activePlayer = currentState.players[currentState.currentTurn];
    const turnName = (currentState.currentTurn === mySeat) ? '我' : (activePlayer ? activePlayer.name : '未知');
    
    let phaseText = '摸牌階段';
    if (currentState.phase === 'DISCARD') phaseText = '出牌思考中';
    if (currentState.phase === 'CLAIM_WINDOW') phaseText = '吃／胡裁決窗口';
    if (currentState.phase === 'ROUND_OVER') phaseText = '本局結算中';

    document.getElementById('turn-indicator').innerText = `輪到：${turnName} (${phaseText})`;
    document.getElementById('deck-counter').innerText = `牌庫剩餘: ${currentState.deckCount} 張`;

    // 回合倒數計時進度條
    updateTurnTimer();

    // 最新棄牌聚光燈
    const spotlightSlot = document.getElementById('spotlight-card-slot');
    const claimBanner = document.getElementById('claim-banner');
    spotlightSlot.innerHTML = '';

    const lastCard = currentState.discardPile[currentState.discardPile.length - 1];
    if (lastCard) {
        const scDom = createCardDOM(lastCard, false);
        scDom.classList.add('spotlight');
        spotlightSlot.appendChild(scDom);
    } else {
        spotlightSlot.innerHTML = '<span class="empty-slot-text">目前尚無出牌</span>';
    }

    if (currentState.phase === 'CLAIM_WINDOW') {
        claimBanner.style.display = 'block';
    } else {
        claimBanner.style.display = 'none';
    }

    // 歷史棄牌網格 (縮小版，扣除最新一張已在聚光燈)
    const grid = document.getElementById('discard-grid');
    grid.innerHTML = '';
    const historyCards = currentState.discardPile.slice(0, -1);
    historyCards.forEach(c => {
        const miniCard = createCardDOM(c, false);
        miniCard.classList.add('mini');
        grid.appendChild(miniCard);
    });
    grid.scrollTop = grid.scrollHeight;
}

// 渲染三方對手座位 (固定卡槽，杜絕負位移破版)
function renderOpponentsSeats() {
    const seatMap = {
        2: document.getElementById('seat-right'),
        3: document.getElementById('seat-top'),
        4: document.getElementById('seat-left')
    };

    // 清空座位
    Object.values(seatMap).forEach(el => el.innerHTML = '');

    for (let i = 0; i < 4; i++) {
        if (i === mySeat) continue;
        const domIdx = getDomPlayerIndex(i, mySeat);
        const container = seatMap[domIdx];
        if (!container) continue;

        const p = currentState.players[i];
        if (!p) continue;

        const isCurrent = (currentState.currentTurn === i && currentState.status === 'PLAYING');

        // 資訊面板
        const panel = document.createElement('div');
        panel.className = `seat-card-panel ${isCurrent ? 'active-turn' : ''}`;
        panel.innerHTML = `
            <div class="seat-name-text">${p.name} ${p.isBot ? '🤖' : ''}${p.isAiTakeover ? ' 🤖託管' : ''}</div>
            <div class="seat-points-text">${p.points} 點</div>
            <div class="seat-hand-badge">🀄 暗牌: ${p.handCount} 張</div>
        `;
        container.appendChild(panel);

        // 外露牌架
        if (p.exposed && p.exposed.length > 0) {
            const rack = document.createElement('div');
            rack.className = 'exposed-rack';
            p.exposed.forEach(set => {
                const miniSet = document.createElement('div');
                miniSet.className = 'mini-set';
                set.forEach(c => {
                    const cd = createCardDOM(c, false);
                    cd.classList.add('mini');
                    miniSet.appendChild(cd);
                });
                rack.appendChild(miniSet);
            });
            container.appendChild(rack);
        }
    }
}

// 渲染底部自己區域 (手牌、外露、按鈕)
function renderBottomMyArea() {
    const me = currentState.players[mySeat];
    if (me) {
        document.getElementById('my-name').innerText = `${me.name} (您)`;
        document.getElementById('my-points').innerText = `${me.points} 點`;

        // 自己的外露組
        const rack = document.getElementById('my-exposed-rack');
        rack.innerHTML = '';
        if (me.exposed && me.exposed.length > 0) {
            me.exposed.forEach(set => {
                const miniSet = document.createElement('div');
                miniSet.className = 'mini-set';
                set.forEach(c => {
                    const cd = createCardDOM(c, false);
                    cd.classList.add('mini');
                    miniSet.appendChild(cd);
                });
                rack.appendChild(miniSet);
            });
        }
    }

    renderMyHand();
    renderActionButtons();
}

// 依現有牌面計算一組電中性化合物的電荷；僅供玩家本地分組提示。
function getVisualSetCharge(tiles) {
    const cations = tiles.filter(tile => tile.type === 'cation');
    const anions = tiles.filter(tile => tile.type === 'anion');
    const coeffs = tiles.filter(tile => tile.type === 'coeff');
    if (cations.length !== 1 || anions.length !== 1) return 0;

    const cationValue = cations[0].val;
    const anionValue = anions[0].val;
    if (coeffs.length === 0) return cationValue === anionValue ? cationValue : 0;
    if (coeffs.length === 1) {
        if (coeffs[0].val * cationValue === anionValue) return anionValue;
        if (cationValue === coeffs[0].val * anionValue) return cationValue;
        return 0;
    }
    if (coeffs.length === 2) {
        if (coeffs[0].val * cationValue === coeffs[1].val * anionValue) return coeffs[0].val * cationValue;
        if (coeffs[1].val * cationValue === coeffs[0].val * anionValue) return coeffs[1].val * cationValue;
    }
    return 0;
}

// 在玩家拖曳後的順序中尋找不重疊、涵蓋牌數最多的連續中性組。
function findVisualNeutralGroups(cards) {
    const memo = new Map();
    const chooseBetter = (candidate, current) => {
        if (candidate.covered !== current.covered) return candidate.covered > current.covered ? candidate : current;
        if (candidate.charge !== current.charge) return candidate.charge > current.charge ? candidate : current;
        return candidate.groups.length < current.groups.length ? candidate : current;
    };
    const solve = start => {
        if (start >= cards.length) return { covered: 0, charge: 0, groups: [] };
        if (memo.has(start)) return memo.get(start);
        let best = solve(start + 1);
        for (let size = 2; size <= 4 && start + size <= cards.length; size++) {
            const groupCards = cards.slice(start, start + size);
            const charge = getVisualSetCharge(groupCards);
            if (!charge) continue;
            const tail = solve(start + size);
            const candidate = {
                covered: tail.covered + size,
                charge: tail.charge + charge,
                groups: [{ start, end: start + size, charge }, ...tail.groups]
            };
            best = chooseBetter(candidate, best);
        }
        memo.set(start, best);
        return best;
    };
    return solve(0).groups;
}

// 渲染自己手牌：依拖曳後的視覺順序，以群組框呈現中性組。
function renderMyHand() {
    const handContainer = document.getElementById('my-hand-container');
    handContainer.innerHTML = '';

    const claimOptions = currentState.availableActions?.claimOptions;
    const claimCandidateIds = new Set((claimOptions?.eatCombos || []).flatMap(combo => combo.map(card => card.id)));
    const orderedCards = getOrderedMyHand();
    const groupStarts = new Map(findVisualNeutralGroups(orderedCards).map(group => [group.start, group]));

    const createHandCard = c => {
        const cardDom = createCardDOM(c, false);
        if (c.id === currentState.lastDrawnCardId) {
            cardDom.classList.add('last-drawn');
        }
        if (c.id === selectedCardId) {
            cardDom.classList.add('selected');
        }
        if (claimSelectionMode && claimCandidateIds.has(c.id)) {
            cardDom.classList.add('claim-candidate');
        }
        if (claimSelectedCardIds.includes(c.id)) {
            cardDom.classList.add('claim-selected');
        }

        // 電腦可拖曳排序；觸控裝置沿用既有兩次點選防手滑機制。
        cardDom.draggable = true;
        cardDom.addEventListener('dragstart', event => {
            draggedCardId = c.id;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', String(c.id));
            cardDom.classList.add('dragging');
        });
        cardDom.addEventListener('dragend', () => {
            draggedCardId = null;
            cardDom.classList.remove('dragging');
            suppressCardClick = true;
            setTimeout(() => { suppressCardClick = false; }, 0);
        });
        cardDom.addEventListener('dragover', event => {
            event.preventDefault();
            if (draggedCardId && draggedCardId !== c.id) cardDom.classList.add('drag-over');
        });
        cardDom.addEventListener('dragleave', () => cardDom.classList.remove('drag-over'));
        cardDom.addEventListener('drop', event => {
            event.preventDefault();
            cardDom.classList.remove('drag-over');
            const sourceId = Number(event.dataTransfer.getData('text/plain')) || draggedCardId;
            if (sourceId) moveHandCard(sourceId, c.id);
        });

        // 觸控點選手牌 (兩次點擊防手滑打出)
        cardDom.onclick = () => {
            if (suppressCardClick) return;
            handleHandCardClick(c.id);
        };

        return cardDom;
    };

    for (let index = 0; index < orderedCards.length;) {
        const group = groupStarts.get(index);
        if (group) {
            const wrapper = document.createElement('div');
            wrapper.className = 'hand-neutral-group';
            wrapper.title = `電中性組合（電荷 ${group.charge}）`;
            wrapper.setAttribute('aria-label', `電中性組合，電荷 ${group.charge}`);
            orderedCards.slice(group.start, group.end).forEach(card => wrapper.appendChild(createHandCard(card)));
            handContainer.appendChild(wrapper);
            index = group.end;
        } else {
            handContainer.appendChild(createHandCard(orderedCards[index]));
            index += 1;
        }
    }
}

// 點選手牌邏輯
function handleHandCardClick(cardId) {
    const claimOptions = currentState.availableActions?.claimOptions;
    if (currentState.phase === 'CLAIM_WINDOW' && claimSelectionMode && claimOptions) {
        const isCandidate = claimOptions.eatCombos.some(combo => combo.some(card => card.id === cardId));
        if (!isCandidate) return;
        if (claimSelectedCardIds.includes(cardId)) {
            claimSelectedCardIds = claimSelectedCardIds.filter(id => id !== cardId);
        } else if (claimSelectedCardIds.length < 3) {
            claimSelectedCardIds = [...claimSelectedCardIds, cardId];
        }
        renderMyHand();
        renderActionButtons();
        return;
    }
    if (currentState.phase !== 'DISCARD' || currentState.currentTurn !== mySeat) {
        selectedCardId = cardId;
        renderMyHand();
        return;
    }

    if (selectedCardId === cardId) {
        // 第二次點擊同一張牌：打出
        socket.emit('action', {
            type: 'DISCARD',
            cardId: cardId,
            actionId: generateActionId()
        });
        selectedCardId = null;
    } else {
        // 第一次點擊：選取彈起
        selectedCardId = cardId;
        renderMyHand();
        renderActionButtons();
    }
}

function getSelectedEatCombo(combos) {
    const selected = [...claimSelectedCardIds].sort((a, b) => a - b).join(',');
    return combos.find(combo => combo.map(card => card.id).sort((a, b) => a - b).join(',') === selected) || null;
}

// 渲染操作按鈕
function renderActionButtons() {
    const actionBar = document.getElementById('bottom-action-bar');
    actionBar.innerHTML = '';

    const actions = currentState.availableActions;
    if (!actions) return;

    // 1. 摸牌按鈕
    if (actions.canDraw) {
        const drawBtn = document.createElement('button');
        drawBtn.className = 'btn btn-green';
        drawBtn.style.fontSize = '18px';
        drawBtn.style.padding = '10px 30px';
        drawBtn.innerText = '🀄 點擊摸牌';
        drawBtn.onclick = () => {
            socket.emit('action', { type: 'DRAW', actionId: generateActionId() });
        };
        actionBar.appendChild(drawBtn);
    }

    // 2. 出牌確認按鈕
    if (actions.canDiscard && selectedCardId) {
        const discardBtn = document.createElement('button');
        discardBtn.className = 'btn';
        discardBtn.innerText = '打出選取的牌 ➔';
        discardBtn.onclick = () => {
            socket.emit('action', {
                type: 'DISCARD',
                cardId: selectedCardId,
                actionId: generateActionId()
            });
            selectedCardId = null;
        };
        actionBar.appendChild(discardBtn);
    }

    // 3. 自摸按鈕
    if (actions.canSelfWin) {
        const winBtn = document.createElement('button');
        winBtn.className = 'huge-win-btn';
        winBtn.innerText = '自摸！';
        winBtn.onclick = () => {
            socket.emit('action', { type: 'SELF_WIN', actionId: generateActionId() });
        };
        actionBar.appendChild(winBtn);
    }

    // 4. 吃牌/胡牌裁決窗口按鈕
    if (actions.claimOptions) {
        const opt = actions.claimOptions;

        // 放槍胡牌
        if (opt.canWin) {
            const huBtn = document.createElement('button');
            huBtn.className = 'huge-win-btn';
            huBtn.innerText = '胡！';
            huBtn.onclick = () => {
                socket.emit('action', { type: 'CLAIM_WIN', actionId: generateActionId() });
            };
            actionBar.appendChild(huBtn);
        }

        // 吃牌改為「選取手牌後確認」，避免多種排列組合堆成大量按鈕。
        if (opt.eatCombos && opt.eatCombos.length > 0) {
            if (!claimSelectionMode) {
                const chooseBtn = document.createElement('button');
                chooseBtn.className = 'btn btn-gold';
                chooseBtn.innerText = `選牌吃（${opt.eatCombos.length} 種）`;
                chooseBtn.onclick = () => {
                    claimSelectionMode = true;
                    claimSelectedCardIds = [];
                    renderMyHand();
                    renderActionButtons();
                };
                actionBar.appendChild(chooseBtn);
            } else {
                const summary = document.createElement('div');
                summary.className = 'claim-selection-summary';
                const selectedNames = claimSelectedCardIds
                    .map(id => currentState.myHand.find(card => card.id === id))
                    .filter(Boolean)
                    .map(card => ION_DISPLAY_MAP[card.text] || card.text);
                summary.innerText = selectedNames.length ? `已選：${selectedNames.join(' + ')}` : '請點選發亮手牌';
                actionBar.appendChild(summary);

                const selectedCombo = getSelectedEatCombo(opt.eatCombos);
                const confirmBtn = document.createElement('button');
                confirmBtn.className = 'btn btn-gold';
                confirmBtn.innerText = selectedCombo ? '確認吃' : '尚未組成可吃組合';
                confirmBtn.disabled = !selectedCombo;
                confirmBtn.onclick = () => {
                    if (!selectedCombo) return;
                    socket.emit('action', {
                        type: 'CLAIM_EAT',
                        comboCardIds: selectedCombo.map(card => card.id),
                        actionId: generateActionId()
                    });
                    claimSelectionMode = false;
                    claimSelectedCardIds = [];
                };
                actionBar.appendChild(confirmBtn);

                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'btn btn-gray';
                cancelBtn.innerText = '取消選牌';
                cancelBtn.onclick = () => {
                    claimSelectionMode = false;
                    claimSelectedCardIds = [];
                    renderMyHand();
                    renderActionButtons();
                };
                actionBar.appendChild(cancelBtn);
            }
        }

        // 放棄按鈕永遠顯示，包含只有胡牌、沒有吃牌組合的情況。
        const passBtn = document.createElement('button');
        passBtn.className = 'btn btn-gray';
        passBtn.innerText = '過';
        passBtn.onclick = () => {
            socket.emit('action', { type: 'CLAIM_PASS', actionId: generateActionId() });
            claimSelectionMode = false;
            claimSelectedCardIds = [];
        };
        actionBar.appendChild(passBtn);
    }
}

// 倒數計時更新
function updateTurnTimer() {
    if (timerInterval) clearInterval(timerInterval);

    const bar = document.getElementById('turn-timer-progress');
    const timerText = document.getElementById('turn-timer-text');
    const actionPanel = document.getElementById('action-timer-panel');
    const actionProgress = document.getElementById('action-timer-progress');
    const actionText = document.getElementById('action-timer-text');
    if (!currentState || !currentState.deadlineAt) {
        bar.style.width = '0%';
        timerText.innerText = '';
        actionPanel.style.display = 'none';
        actionPanel.className = '';
        return;
    }

    const totalSeconds = currentState.phase === 'CLAIM_WINDOW'
        ? 25
        : currentState.phase === 'DISCARD'
            ? 45
            : 10;

    const renderTimer = () => {
        const remaining = Math.max(0, Math.ceil((currentState.deadlineAt - Date.now()) / 1000));
        const percent = Math.min(100, Math.max(0, (remaining / totalSeconds) * 100));
        const isSafe = percent >= 70;
        const isDanger = percent <= 30;
        const color = isSafe ? '#66bb6a' : (isDanger ? '#d32f2f' : '#fbc02d');

        bar.style.width = `${percent}%`;
        timerText.innerText = `${remaining}s`;
        bar.style.backgroundColor = color;

        actionPanel.style.display = 'block';
        actionPanel.className = isDanger ? 'timer-danger' : (!isSafe ? 'timer-warning' : 'timer-safe');
        if (remaining <= 5 && remaining > 0) actionPanel.classList.add('timer-shake');
        actionProgress.style.width = `${percent}%`;
        actionProgress.style.backgroundColor = color;
        actionText.innerText = `${remaining} 秒`;

        if (remaining <= 0) {
            clearInterval(timerInterval);
        }
    };

    renderTimer();
    timerInterval = setInterval(renderTimer, 200);
}

// 卡牌 DOM 生成 (含無障礙角標)
function createCardDOM(card, isHidden) {
    const div = document.createElement('div');
    if (isHidden) {
        div.className = 'card hidden';
    } else {
        div.className = `card ${card.type}`;
        
        // 無障礙角標: 陽離子 +, 陰離子 −, 係數 ×
        let tagIcon = '+';
        if (card.type === 'anion') tagIcon = '−';
        if (card.type === 'coeff') tagIcon = '×';

        const tagSpan = `<span class="card-tag">${tagIcon}</span>`;
        const displayText = ION_DISPLAY_MAP[card.text] || card.text;
        const textSpan = `<span>${displayText}</span>`;

        div.innerHTML = `${tagSpan}${textSpan}`;
        if (card.text === 'CH3COO-') div.style.fontSize = '12px';
    }
    return div;
}

// 結算畫面渲染 (四局大賽制與現時排名榜)
function renderSettlement() {
    const modal = document.getElementById('score-modal');
    const content = document.getElementById('score-content');
    const nextBtn = document.getElementById('score-next-btn');
    const settlement = currentState?.settlement;

    if (!settlement) {
        // ROUND_OVER 卻沒有 settlement 是資料錯誤，不可靜默卡住。
        modal.style.display = 'flex';
        if (content) {
            content.innerText = '本局已結束，但結算資料同步失敗。請等待重新同步。';
        }
        if (nextBtn) {
            nextBtn.disabled = true;
        }
        return;
    }

    const rankingText = settlement.ranking
        .map(p => `${p.rank}. ${p.name}：${p.points} 點`)
        .join('\n');

    const title = settlement.isMatchOver
        ? `最終結算（第 ${settlement.roundNo}/${settlement.maxRounds} 局）`
        : `第 ${settlement.roundNo}/${settlement.maxRounds} 局結算`;

    if (content) {
        content.innerText = `${title}\n\n${settlement.message}\n\n目前排名\n${rankingText}`;
    }

    // 非房主玩家的按鈕應顯示「等待房主開始下一局」並設為 disabled；伺服器仍須驗證房主權限，不能只依前端禁用。
    const isHost = currentState.players && currentState.players.some(p => p.seat === mySeat && p.isHost);
    if (nextBtn) {
        if (!isHost) {
            nextBtn.disabled = true;
            nextBtn.innerText = '等待房主開始下一局';
            nextBtn.className = 'btn btn-gray';
        } else {
            nextBtn.disabled = false;
            nextBtn.innerText = settlement.isMatchOver ? '重新開始四局賽' : '開始下一局';
            nextBtn.className = settlement.isMatchOver ? 'btn btn-gold' : 'btn btn-green';
        }
    }

    modal.style.display = 'flex';
}
