const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const logic = require('./logic/gameLogic');

const app = express();
const server = http.createServer(app);
const DRAW_TIMEOUT_SECONDS = 10;
const DISCARD_TIMEOUT_SECONDS = 45;
const CLAIM_TIMEOUT_SECONDS = 25;
const STARTING_POINTS = 50;
const configuredOrigins = (process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
const io = new Server(server, {
    cors: {
        // 本機開發未設定時允許瀏覽器來源；部署時必須設定 CLIENT_ORIGIN 為正式網站網域。
        origin: configuredOrigins.length > 0 ? configuredOrigins : true,
        methods: ['GET', 'POST']
    }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

// 全域房間與 Session 儲存
const rooms = new Map(); // roomId -> RoomObject
const socketSessions = new Map(); // socket.id -> { roomId, playerId }
const recentActions = new Set(); // actionId 快取去重 (存活 30 秒)

// 產生 6 位數不可預測房號
function generateRoomId() {
    let id;
    do {
        id = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms.has(id));
    return id;
}

// 產生高熵安全 Token
function generateToken() {
    return crypto.randomBytes(16).toString('hex');
}

// 建立安全玩家狀態投影 (絕不向對手洩漏手牌與牌庫)
function makePlayerView(room, playerId) {
    const player = room.players.find(p => p.id === playerId);
    if (!player) return null;

    const mySeat = player.seat;
    const isMyTurn = (room.currentTurn === mySeat);

    // 計算可用動作
    let availableActions = {
        canDraw: false,
        canDiscard: false,
        canSelfWin: false,
        claimOptions: null // { canWin: bool, eatCombos: [] }
    };

    if (room.status === 'PLAYING') {
        if (room.phase === 'DRAW' && isMyTurn) {
            availableActions.canDraw = true;
        } else if (room.phase === 'DISCARD' && isMyTurn) {
            availableActions.canDiscard = true;
            // 檢查自摸
            if (logic.canPartition(player.hand)) {
                availableActions.canSelfWin = true;
            }
        } else if (room.phase === 'CLAIM_WINDOW') {
            const lastCard = room.lastDiscardedCard;
            if (lastCard && room.lastDiscarderSeat !== mySeat) {
                const canWin = logic.canPartition([...player.hand, lastCard]);
                let eatCombos = [];
                // 僅下家可吃
                const isNextSeat = (room.lastDiscarderSeat + 1) % 4 === mySeat;
                if (isNextSeat) {
                    eatCombos = logic.getEatCombos(player.hand, lastCard);
                }
                if (canWin || eatCombos.length > 0) {
                    availableActions.claimOptions = {
                        targetCard: lastCard,
                        canWin,
                        eatCombos
                    };
                }
            }
        }
    }

    return {
        roomId: room.id,
        version: room.version,
        status: room.status,
        phase: room.phase,
        mySeat: mySeat,
        myHand: player.hand,
        lastDrawnCardId: player.lastDrawnCardId || null,
        exposed: player.exposed,
        points: player.points,
        validSetIndices: logic.getValidSetIndices(player.hand),
        deckCount: room.deck.length,
        discardPile: room.discardPile,
        currentTurn: room.currentTurn,
        deadlineAt: room.deadlineAt,
        availableActions,
        settlement: room.settlement || null,
        roundNo: room.roundNo,
        maxRounds: room.maxRounds,
        roundNumber: room.roundNo,
        totalRounds: room.maxRounds,
        dealerSeat: room.dealerSeat || 0,
        players: room.players.map(p => ({
            seat: p.seat,
            name: p.name,
            points: p.points,
            handCount: p.hand.length,
            exposed: p.exposed,
            isConnected: !!p.socketId,
            isBot: p.isBot,
            isAiTakeover: !!p.isAiTakeover,
            isHost: p.id === room.hostPlayerId
        }))
    };
}

// 對全房間每個玩家各自推送專屬安全投影
function broadcastState(room) {
    room.version++;
    for (const p of room.players) {
        if (p.socketId && !p.isBot) {
            const view = makePlayerView(room, p.id);
            io.to(p.socketId).emit('state_sync', view);
        }
    }
}

// 清除計時器
function clearRoomTimer(room) {
    if (room.timerHandle) {
        clearTimeout(room.timerHandle);
        room.timerHandle = null;
    }
    room.deadlineAt = null;
}

// 啟動階段計時器
function setRoomTimer(room, seconds, callback) {
    clearRoomTimer(room);
    room.deadlineAt = Date.now() + seconds * 1000;
    room.timerHandle = setTimeout(() => {
        room.timerHandle = null;
        callback();
    }, seconds * 1000);
}

function isAiControlled(player) {
    return !!(player && (player.isBot || player.isAiTakeover));
}

function runAiDiscard(room, player) {
    if (!isAiControlled(player) || room.phase !== 'DISCARD' || room.currentTurn !== player.seat) return;
    if (logic.canPartition(player.hand)) {
        handleWin(room, player.seat, player.seat, null);
        return;
    }
    const card = player.hand[Math.floor(Math.random() * player.hand.length)];
    if (card) executeDiscard(room, player, card.id);
}

function resumeHumanTurnTimer(room, player) {
    if (!player.socketId || isAiControlled(player)) return;
    if (room.phase === 'DRAW' && room.currentTurn === player.seat) {
        setRoomTimer(room, DRAW_TIMEOUT_SECONDS, () => executeDraw(room, player, true));
    } else if (room.phase === 'DISCARD' && room.currentTurn === player.seat) {
        setRoomTimer(room, DISCARD_TIMEOUT_SECONDS, () => {
            const fallbackId = player.lastDrawnCardId || player.hand[player.hand.length - 1]?.id;
            if (fallbackId) executeDiscard(room, player, fallbackId);
        });
    }
}

function activateAiTakeover(room, player) {
    if (player.socketId || player.isBot || room.status !== 'PLAYING') return;
    player.isAiTakeover = true;
    player.aiTakeoverTimer = null;

    if (room.hostPlayerId === player.id) {
        const replacement = room.players.find(p => p.socketId && !p.isBot && p.id !== player.id);
        if (replacement) room.hostPlayerId = replacement.id;
    }

    broadcastState(room);
    if (room.currentTurn === player.seat) {
        clearRoomTimer(room);
        if (room.phase === 'DRAW') {
            setTimeout(() => {
                if (isAiControlled(player)) executeDraw(room, player);
            }, 800);
        } else if (room.phase === 'DISCARD') {
            setTimeout(() => runAiDiscard(room, player), 800);
        }
    }
    if (room.phase === 'CLAIM_WINDOW') {
        setTimeout(() => {
            if (isAiControlled(player)) recordClaimResponse(room, player.seat, 'PASS', null);
        }, 800);
    }
}

// 進入摸牌階段
function enterDrawPhase(room, seat) {
    room.phase = 'DRAW';
    room.currentTurn = seat;
    const curPlayer = room.players[seat];
    if (curPlayer) {
        curPlayer.lastDrawnCardId = null;
    }

    // 檢查牌庫
    if (room.deck.length === 0) {
        handleDrawGame(room);
        return;
    }

    broadcastState(room);

    // 若是機器人，延遲 1 秒自動摸牌
    if (isAiControlled(curPlayer)) {
        setTimeout(() => {
            if (isAiControlled(curPlayer)) executeDraw(room, curPlayer);
        }, 800);
        return;
    }

    // 真人有 10 秒點擊摸牌；逾時才由伺服器自動摸打。
    setRoomTimer(room, DRAW_TIMEOUT_SECONDS, () => {
        // 逾時自動摸牌並自動打出
        executeDraw(room, curPlayer, true);
    });
}

// 執行摸牌
function executeDraw(room, player, autoDiscard = false) {
    if (room.phase !== 'DRAW' || room.currentTurn !== player.seat) return;
    if (room.deck.length === 0) {
        handleDrawGame(room);
        return;
    }

    const drawnCard = room.deck.pop();
    player.hand.push(drawnCard);
    player.lastDrawnCardId = drawnCard.id;
    room.phase = 'DISCARD';

    broadcastState(room);

    if (autoDiscard) {
        // 逾時自動打出剛摸到的牌
        executeDiscard(room, player, drawnCard.id);
        return;
    }

    if (isAiControlled(player)) {
        setTimeout(() => runAiDiscard(room, player), 1000);
        return;
    }

    // 摸牌後給真人 45 秒思考與出牌。
    setRoomTimer(room, DISCARD_TIMEOUT_SECONDS, () => {
        executeDiscard(room, player, drawnCard.id);
    });
}

// 執行出牌
function executeDiscard(room, player, cardId) {
    if (room.phase !== 'DISCARD' || room.currentTurn !== player.seat) return;
    clearRoomTimer(room);

    const cardIdx = player.hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return;

    const card = player.hand.splice(cardIdx, 1)[0];
    player.lastDrawnCardId = null;
    room.discardPile.push(card);
    room.lastDiscardedCard = card;
    room.lastDiscarderSeat = player.seat;

    // 檢查其他三家是否有搶胡或吃牌資格
    const eligibleClaims = [];
    for (let i = 0; i < 4; i++) {
        if (i === player.seat) continue;
        const otherPlayer = room.players[i];
        const canWin = logic.canPartition([...otherPlayer.hand, card]);
        let eatCombos = [];
        const isNext = (player.seat + 1) % 4 === i;
        if (isNext) {
            eatCombos = logic.getEatCombos(otherPlayer.hand, card);
        }
        if (canWin || eatCombos.length > 0) {
            eligibleClaims.push({
                seat: i,
                canWin,
                eatCombos,
                responded: false,
                action: null
            });
        }
    }

    if (eligibleClaims.length === 0) {
        // 無人可吃胡，直接輪到下家摸牌
        const nextSeat = (player.seat + 1) % 4;
        enterDrawPhase(room, nextSeat);
        return;
    }

    // 開啟 25 秒裁決窗口，讓玩家有足夠時間挑選吃牌組合。
    room.phase = 'CLAIM_WINDOW';
    room.pendingClaims = eligibleClaims;
    broadcastState(room);

    // 檢查候選者是否有 Bot，Bot 自動在 800ms 後 PASS
    eligibleClaims.forEach(claim => {
        const p = room.players[claim.seat];
        if (isAiControlled(p)) {
            setTimeout(() => {
                if (isAiControlled(p)) recordClaimResponse(room, p.seat, 'PASS', null);
            }, 800);
        }
    });

    setRoomTimer(room, CLAIM_TIMEOUT_SECONDS, () => {
        resolveClaims(room);
    });
}

// 記錄玩家對裁決窗口的回應
function recordClaimResponse(room, seat, actionType, comboCardIds) {
    if (room.phase !== 'CLAIM_WINDOW' || !room.pendingClaims) return;
    const claim = room.pendingClaims.find(c => c.seat === seat);
    if (!claim || claim.responded) return;

    claim.responded = true;
    claim.action = actionType;
    claim.comboCardIds = comboCardIds;

    // 若所有候選人都已回應，提早裁決
    const allResponded = room.pendingClaims.every(c => c.responded);
    if (allResponded) {
        clearRoomTimer(room);
        resolveClaims(room);
    }
}

// 裁決吃牌與胡牌
function resolveClaims(room) {
    if (room.phase !== 'CLAIM_WINDOW') return;
    clearRoomTimer(room);

    const card = room.lastDiscardedCard;
    const discarderSeat = room.lastDiscarderSeat;
    const claims = room.pendingClaims || [];
    room.pendingClaims = null;

    // 1. 優先處理胡牌 (放槍)
    // 依順時針離放槍者最近的一家優先
    const winClaims = claims.filter(c => c.action === 'WIN' && c.canWin);
    if (winClaims.length > 0) {
        winClaims.sort((a, b) => {
            const distA = (a.seat - discarderSeat + 4) % 4;
            const distB = (b.seat - discarderSeat + 4) % 4;
            return distA - distB;
        });
        const winner = winClaims[0];
        handleWin(room, winner.seat, discarderSeat, card);
        return;
    }

    // 2. 處理吃牌 (僅限下家且無人胡牌)
    const nextSeat = (discarderSeat + 1) % 4;
    const eatClaim = claims.find(c => c.seat === nextSeat && c.action === 'EAT' && c.comboCardIds);
    if (eatClaim) {
        const eater = room.players[nextSeat];
        // 驗證手牌是否確有這些卡片
        const cardsToTake = [];
        let valid = true;
        for (const cid of eatClaim.comboCardIds) {
            const idx = eater.hand.findIndex(h => h.id === cid);
            if (idx === -1) { valid = false; break; }
            cardsToTake.push(eater.hand[idx]);
        }

        if (valid && logic.isValidSet([card, ...cardsToTake])) {
            // 從手牌移除
            for (const c of cardsToTake) {
                const idx = eater.hand.findIndex(h => h.id === c.id);
                eater.hand.splice(idx, 1);
            }
            // 從棄牌堆移除最新一張
            room.discardPile.pop();
            // 加入外露組合
            eater.exposed.push([card, ...cardsToTake]);

            // 吃牌後跳過摸牌，直接進入該玩家的出牌階段
            room.phase = 'DISCARD';
            room.currentTurn = nextSeat;
            broadcastState(room);

            if (isAiControlled(eater)) {
                setTimeout(() => runAiDiscard(room, eater), 1000);
            } else {
                // 吃牌後同樣給真人 45 秒選擇要打出的牌。
                setRoomTimer(room, DISCARD_TIMEOUT_SECONDS, () => {
                    executeDiscard(room, eater, eater.hand[eater.hand.length - 1].id);
                });
            }
            return;
        }
    }

    // 3. 所有人都 PASS 或吃牌無效，輪到下家摸牌
    enterDrawPhase(room, nextSeat);
}

// 建立統一排名函式 (分數相同以座位號穩定排序)
function buildRanking(room) {
    return room.players
        .map(p => ({
            seat: p.seat,
            name: p.name,
            points: p.points
        }))
        .sort((a, b) => b.points - a.points || a.seat - b.seat)
        .map((p, index) => ({ ...p, rank: index + 1 }));
}

// 結算勝負
function handleWin(room, winnerSeat, discarderSeat, card) {
    clearRoomTimer(room);
    room.phase = 'ROUND_OVER';
    room.status = 'ROUND_OVER';

    const winner = room.players[winnerSeat];
    if (card) {
        winner.hand.push(card);
        room.discardPile.pop();
    }

    const breakdown = logic.calculateScoreBreakdown(winner.hand, winner.exposed);
    const baseScore = breakdown.finalScore;

    let settlementMsg = "";
    if (winnerSeat === discarderSeat) {
        // 自摸
        settlementMsg = `${winner.name} 自摸！
總得點：${baseScore} (含化學加成)
其餘三家各付 ${baseScore} 點。`;
        for (let i = 0; i < 4; i++) {
            if (i !== winnerSeat) {
                room.players[i].points -= baseScore;
                winner.points += baseScore;
            }
        }
    } else {
        // 放槍
        const discarder = room.players[discarderSeat];
        settlementMsg = `${winner.name} 胡牌！${discarder.name} 放槍！
總得點：${baseScore} (含化學加成)`;
        discarder.points -= baseScore;
        winner.points += baseScore;
    }

    if (breakdown.bonusTags.length > 0) {
        settlementMsg += `
觸發加成：${breakdown.bonusTags.join('、')}`;
    }

    const isGameOver = room.players.some(p => p.points <= 0);
    const isMatchOver = isGameOver || room.roundNo >= room.maxRounds;

    room.settlement = {
        winnerSeat,
        winnerName: winner.name,
        discarderSeat,
        discarderName: (winnerSeat === discarderSeat) ? winner.name : room.players[discarderSeat].name,
        isSelfDraw: (winnerSeat === discarderSeat),
        score: baseScore,
        breakdown,
        message: settlementMsg,
        isGameOver: isMatchOver,
        isMatchOver,
        roundNo: room.roundNo,
        maxRounds: room.maxRounds,
        roundNumber: room.roundNo,
        totalRounds: room.maxRounds,
        ranking: buildRanking(room),
        rankings: buildRanking(room),
        bonusTags: breakdown.bonusTags || []
    };

    broadcastState(room);
}

// 流局處理
function handleDrawGame(room) {
    clearRoomTimer(room);
    room.phase = 'ROUND_OVER';
    room.status = 'ROUND_OVER';

    const isMatchOver = room.players.some(p => p.points <= 0)
        || room.roundNo >= room.maxRounds;

    room.settlement = {
        winnerSeat: -1,
        winnerName: '無',
        discarderSeat: -1,
        discarderName: '無',
        isSelfDraw: false,
        score: 0,
        breakdown: { baseHandCharge: 0, baseExposedCharge: 0, totalBonus: 0, finalScore: 0, bonusTags: [] },
        message: '牌庫耗盡，流局！本局不扣點。',
        isGameOver: isMatchOver,
        isMatchOver,
        roundNo: room.roundNo,
        maxRounds: room.maxRounds,
        roundNumber: room.roundNo,
        totalRounds: room.maxRounds,
        ranking: buildRanking(room),
        rankings: buildRanking(room),
        bonusTags: []
    };

    broadcastState(room);
}

// 初始化單局遊戲 (建立牌庫、洗牌、清空棄牌、清空外露組、發每人 12 張牌、設定首摸座位、設為 PLAYING/DRAW、啟動摸牌計時器)
// 不得重設 points, roundNo, maxRounds
function initRound(room, firstSeat = 0) {
    clearRoomTimer(room);
    room.status = 'PLAYING';
    room.phase = 'DRAW';
    room.deck = logic.shuffleDeck(logic.buildDeck());
    room.discardPile = [];
    room.lastDiscardedCard = null;
    room.lastDiscarderSeat = null;
    room.settlement = null;

    // 每人發 12 張初始手牌
    for (const p of room.players) {
        p.hand = [];
        p.exposed = [];
        p.lastDrawnCardId = null;
        for (let i = 0; i < 12; i++) {
            p.hand.push(room.deck.pop());
        }
    }

    // 設定首摸座位 (首摸者固定為座位 0) 並進入摸牌階段
    enterDrawPhase(room, firstSeat);
}

// Socket 連線管理
io.on('connection', (socket) => {
    console.log(`[Socket 連線] ${socket.id}`);

    // 1. 建立房間
    socket.on('create_room', ({ playerName }) => {
        const roomId = generateRoomId();
        const playerId = generateToken();
        const reconnectToken = generateToken();

        const room = {
            id: roomId,
            hostPlayerId: playerId,
            status: 'WAITING',
            phase: 'LOBBY',
            version: 1,
            roundNo: 1,
            maxRounds: 4,
            roundNumber: 1,
            totalRounds: 4,
            roundNumber: 1,
            totalRounds: 4,
            dealerSeat: 0,
            deck: [],
            discardPile: [],
            currentTurn: 0,
            players: [
                {
                    id: playerId,
                    reconnectToken,
                    socketId: socket.id,
                    name: (playerName || '房主').substring(0, 8),
                    seat: 0,
                    points: STARTING_POINTS,
                    hand: [],
                    exposed: [],
                    isBot: false
                }
            ],
            timerHandle: null,
            deadlineAt: null,
            settlement: null
        };

        rooms.set(roomId, room);
        socketSessions.set(socket.id, { roomId, playerId });
        socket.join(roomId);

        socket.emit('room_created', {
            roomId,
            playerId,
            reconnectToken,
            seat: 0
        });

        broadcastState(room);
    });

    // 2. 加入房間
    socket.on('join_room', ({ roomId, playerName, reconnectToken }) => {
        const room = rooms.get(roomId);
        if (!room) {
            socket.emit('error_alert', '找不到此房號，請檢查是否輸入正確！');
            return;
        }

        // 檢查是否為斷線重連
        if (reconnectToken) {
            const existingPlayer = room.players.find(p => p.reconnectToken === reconnectToken);
            if (existingPlayer) {
                if (existingPlayer.aiTakeoverTimer) {
                    clearTimeout(existingPlayer.aiTakeoverTimer);
                    existingPlayer.aiTakeoverTimer = null;
                }
                existingPlayer.isAiTakeover = false;
                existingPlayer.socketId = socket.id;
                socketSessions.set(socket.id, { roomId, playerId: existingPlayer.id });
                socket.join(roomId);
                socket.emit('reconnect_success', { roomId, playerId: existingPlayer.id, seat: existingPlayer.seat });
                broadcastState(room);
                resumeHumanTurnTimer(room, existingPlayer);
                return;
            }
        }

        if (room.status !== 'WAITING') {
            socket.emit('error_alert', '此房間遊戲已經開始，無法加入！');
            return;
        }

        if (room.players.length >= 4) {
            socket.emit('error_alert', '此房間人數已滿 (4/4)！');
            return;
        }

        const seat = room.players.length;
        const playerId = generateToken();
        const token = generateToken();

        room.players.push({
            id: playerId,
            reconnectToken: token,
            socketId: socket.id,
            name: (playerName || `玩家 ${seat + 1}`).substring(0, 8),
            seat,
            points: STARTING_POINTS,
            hand: [],
            exposed: [],
            isBot: false
        });

        socketSessions.set(socket.id, { roomId, playerId });
        socket.join(roomId);

        socket.emit('join_success', {
            roomId,
            playerId,
            reconnectToken: token,
            seat
        });

        broadcastState(room);
    });

    // 3. 加入測試機器人 (Dev Bot)
    socket.on('add_bot', () => {
        const session = socketSessions.get(socket.id);
        if (!session) return;
        const room = rooms.get(session.roomId);
        if (!room || room.status !== 'WAITING' || room.players.length >= 4) return;
        if (room.hostPlayerId !== session.playerId) return;

        const seat = room.players.length;
        const botId = `bot_${generateToken()}`;
        room.players.push({
            id: botId,
            reconnectToken: generateToken(),
            socketId: null,
            name: `AI 助手 ${seat + 1}`,
            seat,
            points: STARTING_POINTS,
            hand: [],
            exposed: [],
            isBot: true
        });

        broadcastState(room);
    });

    // 4. 開始遊戲
    socket.on('start_game', () => {
        const session = socketSessions.get(socket.id);
        if (!session) return;
        const room = rooms.get(session.roomId);
        if (!room || room.status !== 'WAITING') return;
        if (room.hostPlayerId !== session.playerId) return;

        if (room.players.length < 4) {
            socket.emit('error_alert', '人數不足 4 人，可點擊「加入測試機器人」補齊開局！');
            return;
        }

        room.roundNo = 1;
        room.maxRounds = 4;
        initRound(room, 0);
        broadcastState(room);
    });

    // 5. 統一操作 Action (附帶去重與安全驗證)
    socket.on('action', (payload) => {
        const session = socketSessions.get(socket.id);
        if (!session) return;
        const room = rooms.get(session.roomId);
        if (!room) return;
        if (room.status !== 'PLAYING' && room.status !== 'ROUND_OVER') return;

        const player = room.players.find(p => p.id === session.playerId);
        if (!player) return;

        // 操作去重
        if (payload.actionId) {
            if (recentActions.has(payload.actionId)) return;
            recentActions.add(payload.actionId);
            setTimeout(() => recentActions.delete(payload.actionId), 30000);
        }

        if (payload.type !== 'NEXT_ROUND' && room.status !== 'PLAYING') return;

        switch (payload.type) {
            case 'DRAW':
                if (room.phase === 'DRAW' && room.currentTurn === player.seat) {
                    clearRoomTimer(room);
                    executeDraw(room, player, false);
                }
                break;

            case 'DISCARD':
                if (room.phase === 'DISCARD' && room.currentTurn === player.seat) {
                    executeDiscard(room, player, payload.cardId);
                }
                break;

            case 'CLAIM_WIN':
                recordClaimResponse(room, player.seat, 'WIN', null);
                break;

            case 'SELF_WIN':
                if (room.phase === 'DISCARD' && room.currentTurn === player.seat) {
                    if (logic.canPartition(player.hand)) {
                        handleWin(room, player.seat, player.seat, null);
                    }
                }
                break;

            case 'CLAIM_EAT':
                recordClaimResponse(room, player.seat, 'EAT', payload.comboCardIds);
                break;

            case 'CLAIM_PASS':
                recordClaimResponse(room, player.seat, 'PASS', null);
                break;

            case 'NEXT_ROUND': {
                if (room.status !== 'ROUND_OVER' || !room.settlement) break;

                // 僅房主能推進局數，避免四名玩家同時點擊造成重複開局。
                if (player.id !== room.hostPlayerId) break;

                if (room.settlement.isMatchOver) {
                    // 完整四局或有人破產：重新開始一場四局賽。
                    room.players.forEach(p => {
                        p.points = STARTING_POINTS;
                        p.hand = [];
                        p.exposed = [];
                        p.lastDrawnCardId = null;
                    });
                    room.roundNo = 1;
                    room.settlement = null;
                    room.status = 'WAITING';
                    room.phase = 'LOBBY';
                    broadcastState(room);
                    break;
                }

                // 本局結束但整場未結束：直接發下一局，不重設分數。
                room.roundNo += 1;
                room.settlement = null;
                initRound(room); // 使用既有洗牌、發牌、設定首摸者的初始化函式
                broadcastState(room);
                break;
            }
        }
    });

    // 6. 斷線處理
    socket.on('disconnect', () => {
        const session = socketSessions.get(socket.id);
        if (!session) return;
        const room = rooms.get(session.roomId);
        if (!room) return;

        const player = room.players.find(p => p.id === session.playerId);
        if (player) {
            player.socketId = null;
            if (room.status === 'WAITING') {
                // 等待室中直接移除
                room.players = room.players.filter(p => p.id !== player.id);
                if (room.players.length === 0) {
                    rooms.delete(room.id);
                } else {
                    if (room.hostPlayerId === player.id) {
                        room.hostPlayerId = room.players[0].id; // 移交房主
                    }
                    broadcastState(room);
                }
            } else {
                // 遊戲進行中先給 5 秒重連緩衝，之後由 AI 託管；玩家仍有 90 秒可取回座位。
                broadcastState(room);
                player.aiTakeoverTimer = setTimeout(() => activateAiTakeover(room, player), 5000);
                setTimeout(() => {
                    if (!player.socketId) {
                        console.log(`[玩家超時未重連] ${player.name}`);
                    }
                }, 90000);
            }
        }
        socketSessions.delete(socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`離子麻將多人伺服器已啟動於 port ${PORT}`);
});
