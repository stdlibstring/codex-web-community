import io

import av
import numpy as np


def decode_recording(data):
    resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
    chunks = []
    samples = 0
    with av.open(io.BytesIO(data)) as container:
        for frame in container.decode(audio=0):
            frame.pts = None
            for result in resampler.resample(frame):
                samples += result.samples
                if samples > 121 * 16000:
                    raise ValueError("录音长度超过两分钟。")
                chunks.append(result.to_ndarray().reshape(-1))
        for result in resampler.resample(None):
            samples += result.samples
            if samples > 121 * 16000:
                raise ValueError("录音长度超过两分钟。")
            chunks.append(result.to_ndarray().reshape(-1))
    if samples == 0:
        raise ValueError("录音没有可解码的音频采样。")
    return np.concatenate(chunks)


def prepare_audio(audio):
    if not np.isfinite(audio).all():
        raise ValueError("录音包含无效的采样值。")
    peak = float(np.max(np.abs(audio), initial=0))
    if peak == 0:
        return audio
    rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
    # 补偿偏小的录音，同时限制增益与峰值，避免放大后削波。
    gain = min(1000.0, 0.08 / rms, 0.95 / peak)
    return audio * np.float32(gain) if gain > 1 else audio
