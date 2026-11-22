import { createNpcClock } from './npc-clock.ts';
import { interpolateDoorPoses, readDoorPoses, type DoorPose } from '../building-interiors/index.ts';
import { ONLINE_DAY_MS, onlineDayHour } from '../../simulation/daylight.ts';
import type { PlaySession } from '../../core/context.ts';
import type { CharacterSnapshot, MoveCommand, Receipt } from '../characters/index.ts';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { CAR_GUIDES, finiteRotation, MAX_ROOM_PLAYERS, parsePacket, PROTOCOL, readVehicle, readNpcFrame, record, type NpcFrame, type VehicleCommand, type VehicleSnapshot } from '../../simulation/online-protocol.ts';

const KEY = 'modular-game/online';
const BUFFER_MS = 100;
type Frame = { tick: number; npcTick?: number; doors: readonly DoorPose[]; vehicle: VehicleSnapshot; dayPhaseMs: number; players: CharacterSnapshot[]; arrival: number };

function readPlayer(value: unknown, tick: number): value is Omit<CharacterSnapshot, 'ownerId'> {
  if (!record(value)) return false;
  return typeof value.id === 'string' && value.tick === tick &&
    ['x', 'y', 'z', 'yaw', 'verticalSpeed', 'airborneTicks', 'landedTick', 'lastSequence']
      .every(key => typeof value[key] === 'number' && Number.isFinite(value[key])) &&
    ['grounded', 'boosted', 'moving', 'running'].every(key => typeof value[key] === 'boolean') &&
    (value.mode === 'walk' || value.mode === 'fly' || value.mode === 'swim') &&
    (value.stance === 'standing' || value.stance === 'crouching' || value.stance === 'prone') &&
    !('entranceDoors' in value) &&
    (value.vehicleId === undefined
      ? value.vehicleRotation === undefined && value.vehicleAnimation === undefined
      : value.vehicleId === 'car/0' && (value.vehicleAnimation === 'driving'
        ? finiteRotation(value.vehicleRotation)
        : value.vehicleRotation === undefined && (value.vehicleAnimation === 'approaching' ||
          value.vehicleAnimation === 'entering' || value.vehicleAnimation === 'exiting' || value.vehicleAnimation === 'crawling')));
}

export function createOnlineConnection(play?: PlaySession) {
  const endpoint = import.meta.env.VITE_GAME_WS_URL ||
    (import.meta.env.DEV ? 'ws://127.0.0.1:5177/room' : '');
  let world = '';
  let socket: WebSocket | undefined;
  let desired = false;
  let id = '';
  let epoch = '';
  let status = '';
  function report(message: string) {
    status = message;
    play?.status(message, !!id);
  }
  let attempts = 0;
  let sequence = 0;
  let frames: Frame[] = [];
  let npcs: NpcFrame|undefined;
  let presentation: ReturnType<typeof displayFrames>;
  let displayTick = -1;
  const npcClock = createNpcClock();
  const receipts = new Map<number, (receipt: Receipt) => void>();
  function clearReceipts() {
    for (const resolve of receipts.values()) resolve({ accepted: false, reason: 'offline' });
    receipts.clear();
  }
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let handshake: ReturnType<typeof setTimeout> | undefined;
  function stored(): { token?: string } {
    try {
      const value = parsePacket(sessionStorage.getItem(KEY + endpoint + '/' + play?.characterId) ?? '');
      return record(value) ? { token: typeof value.token === 'string' ? value.token : undefined } : {};
    } catch { return {}; }
  }
  function save(token: string | undefined) {
    try { sessionStorage.setItem(KEY + endpoint + '/' + play?.characterId, JSON.stringify({ token })); } catch { /* Optional reload recovery. */ }
  }
  function connect() {
    if (!desired || !play) return;
    report(id ? 'Переподключение…' : 'Подключение…');
    let current: WebSocket;
    try { current = new WebSocket(endpoint); }
    catch { desired = false; id = ''; frames = []; save(stored().token); report('Некорректный адрес игрового сервера.'); return; }
    socket = current;
    let welcomed = false;
    handshake = setTimeout(() => current.close(), 5000);
    current.onopen = async () => {
      try {
        const accessToken = await play.accessToken();
        if (socket === current && current.readyState === WebSocket.OPEN) current.send(JSON.stringify({
          type: 'join', protocol: PROTOCOL, world, token: stored().token, characterId: play.characterId, accessToken,
        }));
      } catch { if (socket === current) current.close(4003); }
    };
    current.onmessage = event => {
      if (socket !== current || typeof event.data !== 'string') return;
      const packet = parsePacket(event.data);
      if (welcomed && record(packet) && packet.type === 'npcs') {
        const data=readNpcFrame(packet.data);
        if(!data){current.close(4002);return;}
        if(!npcs||data.tick>=npcs.tick)npcs=data;
        return;
      }
      if (welcomed && record(packet) && packet.type === 'receipt' &&
        typeof packet.sequence === 'number' && typeof packet.accepted === 'boolean' && typeof packet.reason === 'string') {
        const resolve = receipts.get(packet.sequence);
        receipts.delete(packet.sequence);
        resolve?.({ accepted: packet.accepted, reason: packet.reason });
        return;
      }
      if (!record(packet) || typeof packet.tick !== 'number' || !Number.isSafeInteger(packet.tick) || packet.tick < 0 ||
        typeof packet.dayPhaseMs !== 'number' || !Number.isFinite(packet.dayPhaseMs) || packet.dayPhaseMs < 0 || packet.dayPhaseMs >= ONLINE_DAY_MS ||
        !Array.isArray(packet.players) || packet.players.length > MAX_ROOM_PLAYERS) { current.close(4002); return; }
      const tick = packet.tick;
      const npcTick=packet.npcTick;
      if(npcTick!==undefined && (typeof npcTick!=='number'||!Number.isSafeInteger(npcTick)||npcTick<tick)){
        current.close(4002);return;
      }
      const doors = readDoorPoses(packet.doors);
      if (!doors || !readVehicle(packet.vehicle, tick)) { current.close(4002); return; }
      const players: CharacterSnapshot[] = [];
      for (const value of packet.players) {
        if (!readPlayer(value, tick)) { current.close(4002); return; }
        players.push({ ...value, ownerId: value.id });
      }
      if (!welcomed) {
        if (packet.type !== 'welcome' || packet.protocol !== PROTOCOL || packet.world !== world ||
          typeof packet.epoch !== 'string' || typeof packet.id !== 'string' || typeof packet.token !== 'string') {
          current.close(4002); return;
        }
        const self = players.find(player => player.id === packet.id);
        if (!self) { current.close(4002); return; }
        id = self.id;
        if (epoch !== packet.epoch) npcClock.reset();
        epoch = packet.epoch;
        sequence = self.lastSequence;
        frames = [];
        npcs = undefined;
        displayTick = -1;
        welcomed = true;
        attempts = 0;
        clearTimeout(handshake);
        save(packet.token);
        report('В сети');
      } else if (packet.type !== 'frame' || tick <= (frames.at(-1)?.tick ?? -1)) return;
      frames.push({ tick, npcTick, players, doors, vehicle: packet.vehicle, dayPhaseMs: packet.dayPhaseMs, arrival: performance.now() });
      if (frames.length > 16) frames.shift();
    };
    current.onclose = event => {
      if (socket !== current) return;
      clearTimeout(handshake);
      socket = undefined;
      clearReceipts();
      if (!id || event.code === 4001 || event.code === 4003 || event.code === 4004 || event.code === 1008 || event.code === 4002) {
        desired = false;
        id = '';
        frames = [];
        npcs = undefined;
        save(event.code === 4001 ? undefined : stored().token);
        report(event.code === 4001 || event.code === 4004 ? 'Этот персонаж уже в игре.' :
          event.code === 4003 ? 'Доступ к персонажу отклонён. Войдите снова.' : 'Не удалось подключиться к игровой комнате.');
        return;
      }
      report('Соединение потеряно. Переподключение…');
      reconnect = setTimeout(connect, Math.min(8000, 500 * 2 ** Math.min(attempts++, 4)) + Math.random() * 200);
    };
  }
  function stop() {
    desired = false;
    id = '';
    frames = [];
    npcs = undefined;
    presentation = undefined;
    npcClock.reset();
    displayTick = -1;
    status = '';
    clearReceipts();
    clearTimeout(reconnect);
    clearTimeout(handshake);
    const current = socket;
    socket = undefined;
    current?.close();
  }

  function displayFrames() {
    const newest = frames.at(-1);
    if (!newest) return undefined;
    const bufferedTick = newest.tick + Math.min(BUFFER_MS, performance.now() - newest.arrival) * .06 - BUFFER_MS * .06;
    const target = displayTick = Math.max(displayTick, frames[0].tick, bufferedTick);
    const next = frames.find(frame => frame.tick >= target) ?? newest;
    const previous = frames[frames.indexOf(next) - 1];
    const alpha = previous ? Math.max(0, (target - previous.tick) / (next.tick - previous.tick)) : 1;
    const to = next.vehicle;
    const from = previous?.vehicle ?? to;
    const blend = (a: number, b: number) => a + (b - a) * alpha;
    const position = (a: readonly number[], b: readonly number[]) => b.map((v,i) => blend(a[i],v));
    const steeringAngle = blend(from.steering,to.steering);
    const rotation = Quaternion.Slerp(Quaternion.FromArray(from.rotation), Quaternion.FromArray(to.rotation), alpha);
    const vehicle: VehicleSnapshot = {
      ...(alpha < 1 ? from : to), position: position(from.position, to.position), rotation: rotation.asArray(),
      steering: steeringAngle, leftDoor: blend(from.leftDoor,to.leftDoor), rightDoor: blend(from.rightDoor,to.rightDoor),
      wheels: to.wheels.map((wheel,i) => {
        const spin = blend(from.wheels[i].spin,wheel.spin);
        const steering = Quaternion.RotationAxis(Vector3.Up(), i < 2 ? steeringAngle : 0);
        const rolling = Quaternion.RotationAxis(Vector3.Left(),spin);
        return { position: position(from.wheels[i].position,wheel.position), rotation: rotation.multiply(steering).multiply(rolling).asArray(), spin };
      }),
    };
    function player(latest: CharacterSnapshot) {
      const to = next.players.find(actor => actor.id === latest.id) ?? latest;
      const from = previous?.players.find(actor => actor.id === latest.id) ?? to;
      const state = alpha < 1 ? from : to;
      if (state.vehicleAnimation === 'driving') {
        const seat = new Vector3(CAR_GUIDES.seat.x,CAR_GUIDES.seat.y,CAR_GUIDES.seat.z);
        seat.rotateByQuaternionToRef(rotation,seat);
        return { ...state, x: vehicle.position[0]+seat.x, y: vehicle.position[1]+seat.y, z: vehicle.position[2]+seat.z,
          vehicleRotation: vehicle.rotation };
      }
      const turn = Math.atan2(Math.sin(to.yaw - from.yaw), Math.cos(to.yaw - from.yaw));
      return { ...state, x: blend(from.x, to.x), y: blend(from.y, to.y), z: blend(from.z, to.z), yaw: from.yaw + turn * alpha };
    }
    return { newest, next, previous, alpha, vehicle, player };
  }

  return {
    endpoint,
    npcs: () => npcs,
    npcTick() {
      const frame = frames.at(-1);
      return frame?.npcTick === undefined ? 0 : npcClock.sample(frame.npcTick, frame.arrival, performance.now());
    },
    npcCorrectionTick() {
      const frame = frames.at(-1);
      return frame?.npcTick === undefined ? 0 : frame.npcTick - frame.tick + displayTick;
    },
    connected: () => status === 'В сети',
    toggle(enabled: boolean, map: string) {
      if (!enabled) stop();
      else if (!desired && endpoint) { world = map; desired = true; attempts = 0; connect(); }
      save(stored().token);
    },
    dayHour() {
      const frame = frames.at(-1);
      return frame && onlineDayHour(frame.dayPhaseMs + Math.min(250, performance.now() - frame.arrival));
    },
    doors: () => frames.at(-1)?.doors,
    latest: () => frames.at(-1)?.players ?? [],
    self: () => frames.at(-1)?.players.find(player => player.id === id),
    samplePresentation() { presentation = displayFrames(); },
    vehicle: () => frames.at(-1)?.vehicle,
    displayVehicle: () => presentation?.vehicle,
    displaySelf() {
      const latest = frames.at(-1)?.players.find(player => player.id === id);
      if (!latest || !presentation) return undefined;
      const display = presentation.player(latest);
      return latest.vehicleId || display.vehicleId ? display : undefined;
    },
    displayDoors() {
      const sample = presentation;
      if (!sample) return undefined;
      const { next, previous, alpha } = sample;
      if (!previous || alpha === 1 || (!previous.doors.length && !next.doors.length)) return next.doors;
      return interpolateDoorPoses(previous.doors, next.doors, alpha);
    },
    remote() {
      const sample = presentation;
      return sample ? sample.newest.players.filter(player => player.id !== id).map(sample.player) : [];
    },
    identity: () => id && `${epoch}/${id}`,
    send(command: MoveCommand | VehicleCommand): Promise<Receipt> {
      const current = socket;
      const latest = frames.at(-1);
      if (status !== 'В сети' || !id || !latest || current?.readyState !== WebSocket.OPEN || current.bufferedAmount > 4096 || receipts.size >= 32) {
        return Promise.resolve({ accepted: false, reason: 'offline' });
      }
      const sent = ++sequence;
      return new Promise(resolve => {
        receipts.set(sent, resolve);
        current.send(JSON.stringify({ type: 'input', command: { ...command, characterId: id, sequence: sent, tick: latest.tick } }));
      });
    },
    dispose: stop,
  };
}
