import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import { Readable, PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { AudioPipeline } from "../audio/audio-pipeline.js";
import { DISCORD_SAMPLE_RATE, DISCORD_CHANNELS, BYTES_PER_SAMPLE } from "../constants.js";

/**
 * Wraps @discordjs/voice AudioPlayer to play PCM audio in a voice channel.
 * Accepts raw PCM buffers (any rate/channels) and handles format conversion.
 *
 * Emits:
 *   "playing"  — playback started
 *   "idle"     — playback finished or was stopped
 *   "error"    — player error
 */
export class AudioSender extends EventEmitter {
  private player: AudioPlayer;
  private pipeline: AudioPipeline;
  private connection: VoiceConnection;

  constructor(connection: VoiceConnection, pipeline: AudioPipeline) {
    super();
    this.connection = connection;
    this.pipeline = pipeline;
    this.player = createAudioPlayer();
    this.connection.subscribe(this.player);
    this.setupPlayerEvents();
  }

  /**
   * Play a PCM Buffer.
   * @param pcm    - Raw 16-bit PCM
   * @param sampleRate - Input sample rate (will be converted to 48kHz for Discord)
   * @param channels   - Number of input channels (1 = mono, 2 = stereo)
   */
  playBuffer(pcm: Buffer, sampleRate: number, channels = 1): void {
    const discord48k = this.pipeline.toDiscordFormat(pcm, sampleRate, channels);
    const readable = Readable.from(this.bufferToChunks(discord48k));
    const resource = createAudioResource(readable, {
      inputType: StreamType.Raw,
    });
    this.player.play(resource);
  }

  /**
   * Play a PCM stream that emits chunks progressively.
   * The stream should emit Buffers of 16-bit PCM at the given sampleRate.
   */
  playStream(
    source: EventEmitter & {
      on(event: "audio", handler: (chunk: Buffer, sampleRate: number) => void): unknown;
      once(event: "end", handler: () => void): unknown;
      once(event: "error", handler: (err: Error) => void): unknown;
    },
  ): void {
    const passthrough = new Readable({ read() {} });

    source.on("audio", (chunk: Buffer, rate: number) => {
      const discord48k = this.pipeline.toDiscordFormat(chunk, rate, 1);
      passthrough.push(discord48k);
    });

    // End the stream when the source signals completion
    const finish = () => { passthrough.push(null); };
    source.once("end", finish);
    source.once("error", (err: Error) => {
      passthrough.destroy(err);
    });

    const resource = createAudioResource(passthrough, {
      inputType: StreamType.Raw,
    });
    this.player.play(resource);
  }

  /**
   * Create a PassThrough stream and start playing it immediately.
   * Write pre-converted 48kHz stereo PCM to the returned stream.
   * End or destroy the stream to stop playback.
   */
  createPassthrough(): PassThrough {
    const passthrough = new PassThrough();
    const resource = createAudioResource(passthrough, { inputType: StreamType.Raw });
    this.player.play(resource);
    return passthrough;
  }

  /** Stop current playback immediately. */
  stop(): void {
    this.player.stop(true);
  }

  get isPlaying(): boolean {
    return this.player.state.status === AudioPlayerStatus.Playing;
  }

  dispose(): void {
    this.player.stop(true);
    this.removeAllListeners();
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private setupPlayerEvents(): void {
    this.player.on(AudioPlayerStatus.Playing, () => {
      this.emit("playing");
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.emit("idle");
    });

    this.player.on("error", (err: Error) => {
      this.emit("error", err);
    });
  }

  /**
   * Split a large PCM buffer into fixed-size Opus frame chunks
   * for smooth streaming to Discord.
   */
  private *bufferToChunks(pcm: Buffer): Generator<Buffer> {
    // 20ms at 48kHz stereo = 3840 bytes
    const chunkSize = (DISCORD_SAMPLE_RATE / 50) * DISCORD_CHANNELS * BYTES_PER_SAMPLE;
    let offset = 0;
    while (offset < pcm.length) {
      yield pcm.subarray(offset, offset + chunkSize);
      offset += chunkSize;
    }
  }
}
