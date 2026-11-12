package ru.uspevator.app;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.util.Log;

import java.util.EnumMap;

final class SignalPlayer {
    private static final int RATE = 24_000;
    private static final int WARNING_HZ = 620, BUFFER_HZ = 660;
    private final EnumMap<SignalSchedule.Pattern, AudioTrack> tracks =
        new EnumMap<>(SignalSchedule.Pattern.class);
    private AudioTrack active;
    private SignalSchedule.Pattern current = SignalSchedule.Pattern.SILENCE;
    private float volume;

    void setVolume(int percent) {
        volume = .34f * (float) Math.sqrt(Math.max(10, Math.min(100, percent)) / 100.0);
        if (active != null) active.setVolume(gain(current));
    }

    private float gain(SignalSchedule.Pattern pattern) {
        return pattern == SignalSchedule.Pattern.CONTINUOUS ? volume * .78f : volume;
    }

    void play(SignalSchedule.Pattern pattern) {
        if (pattern == SignalSchedule.Pattern.KEEP) return;
        if (pattern == SignalSchedule.Pattern.CONTINUOUS && pattern == current && active != null) return;
        stop();
        if (pattern == SignalSchedule.Pattern.SILENCE) return;
        try {
            AudioTrack track = tracks.get(pattern);
            if (track == null) {
                track = create(pattern);
                tracks.put(pattern, track);
            }
            active = track;
            current = pattern;
            track.setPlaybackHeadPosition(0);
            track.setVolume(gain(pattern));
            track.play();
        } catch (RuntimeException error) {
            stop();
            AudioTrack failed = tracks.remove(pattern);
            if (failed != null) failed.release();
            Log.w("UspevatorAudio", "Cannot play task signal", error);
        }
    }

    void stop() {
        if (active != null) {
            try { active.stop(); }
            catch (IllegalStateException ignored) { /* Already released by the audio system. */ }
            active = null;
        }
        current = SignalSchedule.Pattern.SILENCE;
    }

    void close() {
        stop();
        for (AudioTrack track : tracks.values()) track.release();
        tracks.clear();
    }

    private static AudioTrack create(SignalSchedule.Pattern pattern) {
        boolean continuous = pattern == SignalSchedule.Pattern.CONTINUOUS;
        boolean warning = pattern == SignalSchedule.Pattern.WARNING;
        int count = RATE * (continuous ? 1000 : warning ? SignalSchedule.WARNING_MS : SignalSchedule.PULSE_MS) / 1000;
        short[] pcm = new short[count];
        if (continuous) {
            for (int i = 0; i < count; i++) pcm[i] = sample(i, BUFFER_HZ, 1);
        } else {
            pulse(pcm, 0, warning ? WARNING_HZ : BUFFER_HZ);
            if (warning) pulse(pcm, RATE * 170 / 1000, WARNING_HZ);
        }
        // A local timer cue is mixed at its own gain on the media output. It
        // does not request audio focus, change system volume, or take over media controls.
        AudioTrack track = new AudioTrack.Builder()
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            .setAudioFormat(new AudioFormat.Builder().setSampleRate(RATE)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STATIC).setBufferSizeInBytes(pcm.length * 2).build();
        if (track.write(pcm, 0, pcm.length, AudioTrack.WRITE_BLOCKING) != pcm.length
                || track.getState() != AudioTrack.STATE_INITIALIZED
                || (continuous && track.setLoopPoints(0, pcm.length, -1) != AudioTrack.SUCCESS)) {
            track.release();
            throw new IllegalStateException("Signal track could not be initialized");
        }
        return track;
    }

    private static void pulse(short[] pcm, int offset, int hz) {
        int frames = RATE * SignalSchedule.PULSE_MS / 1000;
        int ramp = RATE * 6 / 1000;
        for (int i = 0; i < frames; i++) {
            double envelope = Math.min(1, Math.min((double) i / ramp, (double) (frames - 1 - i) / ramp));
            pcm[offset + i] = sample(i, hz, envelope);
        }
    }

    private static short sample(int frame, int frequency, double envelope) {
        return (short) Math.round(24_000 * envelope * Math.sin(2 * Math.PI * frequency * frame / RATE));
    }
}
