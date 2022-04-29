import { Conn } from '@rob9315/mcproxy';
import { Client, createServer } from 'minecraft-protocol';
import { Client as Discord, Intents } from 'discord.js';
import { WebServer } from './misc/webserver';
import { onDiscordMessage } from './misc/discord';
import { eta } from './misc/queue';

import type { ProxyOptions } from './misc/config';
import type { Bot, BotOptions } from 'mineflayer';
import type { PacketMeta, Server } from 'minecraft-protocol';

// the Proxy class, instantiated by passing ProxyOptions
export class Proxy {
  conn: Conn | undefined;
  server: Server;

  // optional features
  webserver?: WebServer;
  discord?: Discord;

  // keeping track of the state of the proxy
  private _state: 'idle' | 'condition' | 'auth' | 'connected' | 'afk' | 'reconnecting' | 'queue' = 'idle';

  private _queue: number | undefined;
  private _teams: { [name: string]: string[] } = {};

  private _timeout: (NodeJS.Timeout & { start: number; end: number }) | undefined;

  constructor(public options: ProxyOptions) {
    this.server = createServer(this.options.mcserver).on('login', onServerLogin.bind(this));
    if (this.options.discord) {
      this.discord = new Discord({ ws: { intents: Intents.ALL } }).on('message', onDiscordMessage);
      this.discord.login(this.options.discord.token);
    }
    if (this.options.webserver) this.webserver = new WebServer(this.options.webserver, this);
    if (this.options.extra?.startImmediately) this.state = 'auth';
  }

  set state(state: typeof Proxy.prototype._state) {
    switch (this._state) {
      case 'queue':
        [this._queue, this._teams] = [undefined, {}];
        break;
      case 'afk':
        if (this.options.antiafk) (this.conn?.bot as any)?.afk?.stop();
        break;
      case 'reconnecting':
        this.timeout = undefined;
        break;
    }
    switch (state) {
      case 'idle':
        this.conn?.disconnect();
        this.conn = undefined;
        break;
      case 'auth':
        this.options.mcclient.plugins = this.options.mcclient.plugins ?? {};
        if (!!this.options.antiafk) this.options.mcclient.plugins['afk'] = require('mineflayer-antiafk');
        this.conn = new Conn(this.options.mcclient);
        //* load/customize extensions
        this.options.extensions?.reduce((arr, fn) => [...arr, fn(this.conn as Conn)], [] as (void | ((bot: Bot, options: BotOptions) => void))[]).forEach((v) => !!v && this.conn?.bot.loadPlugin(v));
        if (this.options.antiafk)
          this.conn.bot.once('spawn', async () => {
            (this.conn?.bot as any)?.afk?.setOptions(this.options.antiafk);
            if ((this.conn?.bot as any)?.afk?.chat) (this.conn?.bot as any).afk.chat = function () {};
            if (!this.conn?.pclient) await (this.conn?.bot as any)?.afk?.start();
          });
        this.conn.bot.on('login', () => {this.state = 'queue'});
        this.conn.bot._client.on('end', () => {this.state = this.options.extra?.reconnect ? 'reconnecting' : 'idle'});
        this.conn.bot._client.on('error', () => {this.state = this.options.extra?.reconnect ? 'reconnecting' : 'idle'});
        this.conn.bot._client.on('kick_disconnect', (data: any) => console.error('Kicked with reason', data.reason))
        this.conn.bot._client.on('disconnect', (data: any) => console.error('Kicked with reason', data.reason))
        this.conn.bot._client.on('packet', onClientPacket.bind(this));
        break;
      case 'afk':
        if (this.options.antiafk)
          (async () => {
            while (!(this.conn?.bot as any)?.afk?.enabled) await (this.conn?.bot as any)?.afk?.start();
          })();
        break;
      case 'reconnecting':
        this.conn?.disconnect();
        this.conn = undefined;
        this.timeout = [() => (this.state = 'auth'), this.options.extra?.reconnect?.timeout as number];
        break;
    }
    this._state = state;
    this.update();
  }
  get state() {
    return this._state;
  }

  set teams({ team, mode, players }: { team: string; mode: number; players: string[] }) {
    if (!this._teams[team]) this._teams[team] = [];
    switch (mode) {
      case 0:
        this._teams[team] = players;
        console.log('logged in players:', players.join(', '));
        break;
      case 1:
        this._teams[team] = [];
        console.log('team list reset');
        break;
      case 3:
        this._teams[team].push(...players);
        console.log(players.join(', '), 'joined');
        break;
      case 4:
        console.log(players.map((p) => `${p} (${this._teams[team].findIndex((v) => v == p) + 1})`).join(', '), 'left');
        this._teams[team] = this._teams[team].filter((player) => !players.includes(player));
        break;
      default:
        return;
    }
    this.update();
    // console.log(players.join(', '), mode == 3 ? 'joined' : mode == 4 ? 'left' : mode == 0 ? 'are in' : '?', 'queue');
  }
  set setqueue(position: number) {
    if (this._queue == position) return;
    this._queue = position;
    this.update();
  }
  get getqueue() {
    let position =
      Object.values(this._teams)
        .reduce((p, v) => (v.includes(this.conn?.bot.username as string) ? v : p), [])
        .findIndex((v) => v == this.conn?.bot.username) + 1;
    position = position == 0 ? this._queue ?? position : position;
    let length: number | undefined = Object.values(this._teams).reduce((p, v) => v.length + p, 0);
    length = length == 0 ? undefined : length;
    return { position, length, eta: length ? eta(position, length) : undefined };
  }

  private set timeout(options: [callback: (...args: any[]) => any, duration: number, ...args: any[]] | undefined) {
    if (this._timeout) clearTimeout(this._timeout);
    this._timeout = options ? Object.assign(setTimeout(...options), { start: Date.now(), end: Date.now() }) : undefined;
  }

  update() {
    if (this.state === 'queue' && typeof this.getqueue == 'object') {
      let { position, eta, length } = this.getqueue,
        strTime = eta ? `${Math.floor(eta / 3600)}:`.padStart(3, '0') + `${Math.floor((eta / 60) % 60)}`.padStart(2, '0') : '',
        strPos = `${position}`.padStart(3) + (length ? '/' + `${length}`.padStart(3) : ''),
        str = `Position: ${strPos} ` + (strTime ? `ETA: ${strTime}h` : '');
      this.server.motd = str;
      console.log(str);
    } else {
      this.server.motd = this.state;
      console.log(this._state);
    }
    this.webserver?.update();
  }
}

function onClientPacket(this: Proxy, data: any, { name }: PacketMeta) {
  if (this.state == 'queue') {
    let pos: number | undefined;
    switch (name) {
      case 'playerlist_header':
        pos = parseTabMenu(data);
        break;
      case 'chat':
        pos = parseChatMessage(data);
        break;
      case 'map_chunk':
        this.state = this.conn?.pclient ? 'connected' : 'afk';
        break;
      case 'teams':
        this.teams = data;
        break;
    }
    if (pos) this.setqueue = pos;
  }
  if (name == 'kick_disconnect') this.options.extra?.reconnect ? 'reconnecting' : 'idle';
}

async function onServerLogin(this: Proxy, client: Client) {
  if (this.options.mcserver['online-mode'] && client.uuid !== this.conn?.bot._client.uuid) {
    return client.end('whitelist is enabled, make sure you are using the correct account.');
  }
  if (!this.conn?.bot?.entity?.id) {
    return client.end(`not connected yet...\ncurrent state: '${this.state}'`);
  }
  if (this.state == 'afk') this.state = 'connected';
  this.conn?.sendPackets(client);
  this.conn?.link(client);
  client.on('end', () => {this.state == 'queue' ? undefined : (this.state = 'afk')});
}

export function parseChatMessage(data: { message: string }) {
  try {
    return Number(JSON.parse(data.message).extra[1].text);
  } catch {}
}

export function parseTabMenu(data: { header: string }) {
  try {
    return Number((JSON.parse(data.header)?.text as string).match(/(?<=Position in queue: (?:§.)*)\d+/)?.[0]);
  } catch {}
}
