import { useEffect, useRef, useState } from 'react';
import { MonitorUp, Square } from 'lucide-react';
import { api } from './local-client';

type ShareStatus = 'idle' | 'requesting' | 'waiting' | 'connecting' | 'streaming' | 'error';
type ShareSession = { share_id: string };
type ShareState = { state: 'requested' | 'streaming' | 'ended'; answer?: RTCSessionDescriptionInit | null; message?: string };

function waitForIceGathering(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      peer.removeEventListener('icegatheringstatechange', checkState);
      reject(new Error('Could not establish a direct WebRTC route. This network may require TURN.'));
    }, 15000);
    const checkState = () => {
      if (peer.iceGatheringState !== 'complete') return;
      window.clearTimeout(timeout);
      peer.removeEventListener('icegatheringstatechange', checkState);
      resolve();
    };
    peer.addEventListener('icegatheringstatechange', checkState);
  });
}

export default function ScreenSharePanel({ deviceId, available }: { deviceId: string; available: boolean }) {
  const [status, setStatus] = useState<ShareStatus>('idle');
  const [message, setMessage] = useState('');
  const [shareId, setShareId] = useState('');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const activeShareIdRef = useRef('');
  const appliedAnswerRef = useRef(false);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    if (!shareId) return;
    let stopped = false;
    const checkStatus = async () => {
      try {
        const response = await api.get<ShareState>(`/api/device/screen-share?device_id=${encodeURIComponent(deviceId)}&share_id=${encodeURIComponent(shareId)}`);
        const current = response.data;
        if (stopped) return;
        if (current.state === 'ended') {
          peerRef.current?.close();
          peerRef.current = null;
          activeShareIdRef.current = '';
          setStream(null);
          setStatus('idle');
          setMessage(current.message || 'Screen sharing ended.');
          setShareId('');
          return;
        }
        if (current.answer?.sdp && !appliedAnswerRef.current) {
          appliedAnswerRef.current = true;
          await peerRef.current?.setRemoteDescription(current.answer);
          if (!stopped) setStatus('connecting');
        }
      } catch (error) {
        if (stopped) return;
        peerRef.current?.close();
        peerRef.current = null;
        setStream(null);
        setShareId('');
        setStatus('error');
        setMessage(error instanceof Error ? error.message : 'Could not check the screen share status.');
      }
    };
    void checkStatus();
    const timer = window.setInterval(() => void checkStatus(), 1200);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [deviceId, shareId]);

  useEffect(() => {
    return () => {
      peerRef.current?.close();
      const activeShareId = activeShareIdRef.current;
      if (activeShareId) {
        void api.post('/api/device/screen-share', { device_id: deviceId, action: 'stop', share_id: activeShareId })
        .catch(error => console.warn('Could not stop the screen share after leaving the dashboard:', error));
      }
    };
  }, [deviceId]);

  const start = async () => {
    if (!deviceId || !available || status === 'requesting' || shareId) return;
    if (!window.confirm('Request to view this PC screen? Someone at the PC must approve and start sharing there.')) return;
    setStatus('requesting');
    setMessage('');
    appliedAnswerRef.current = false;
    let createdShareId = '';
    try {
      const created = await api.post<ShareSession>('/api/device/screen-share', { device_id: deviceId, action: 'start' });
      createdShareId = created.data.share_id;
      activeShareIdRef.current = createdShareId;
      setShareId(createdShareId);
      const peer = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      peerRef.current = peer;
      peer.addTransceiver('video', { direction: 'recvonly' });
      peer.ontrack = event => {
        const incoming = event.streams[0] || new MediaStream([event.track]);
        setStream(incoming);
        setStatus('streaming');
        setMessage('Live screen from your approved Windows PC.');
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed') {
          setStatus('error');
          setMessage('Direct WebRTC could not connect. This network may require a TURN relay.');
          void stop();
        } else if (peer.connectionState === 'connected' && !peerRef.current?.getReceivers().some(receiver => receiver.track?.readyState === 'live')) {
          setStatus('connecting');
        }
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
      await api.post('/api/device/screen-share/offer', {
        device_id: deviceId,
        share_id: createdShareId,
        offer: peer.localDescription,
      });
      setStatus('waiting');
      setMessage('Waiting for approval on the Windows PC…');
    } catch (error) {
      if (createdShareId) {
        await api.post('/api/device/screen-share', { device_id: deviceId, action: 'stop', share_id: createdShareId })
          .catch(stopError => console.warn('Could not clean up the failed screen share request:', stopError));
      }
      peerRef.current?.close();
      peerRef.current = null;
      activeShareIdRef.current = '';
      setShareId('');
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Could not request screen sharing.');
    }
  };

  const stop = async () => {
    const activeShareId = shareId;
    peerRef.current?.close();
    peerRef.current = null;
    activeShareIdRef.current = '';
    setStream(null);
    setShareId('');
    setStatus('idle');
    setMessage('Screen share stopped.');
    if (!activeShareId) return;
    try {
      await api.post('/api/device/screen-share', { device_id: deviceId, action: 'stop', share_id: activeShareId });
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Could not send the stop request.');
    }
  };

  return (
    <section className="screen-share-panel" aria-label="Remote screen sharing">
      <div className="screen-share-head">
        <div><h3>PC screen</h3><span>Private, direct WebRTC stream</span></div>
        {status === 'streaming' && <span className="screen-share-live"><i /> LIVE</span>}
      </div>
      {stream ? <video ref={videoRef} autoPlay controls playsInline className="screen-share-video" /> : (
        <div className="screen-share-placeholder"><MonitorUp size={22} /><span>{message || 'View the screen after someone approves on the PC.'}</span></div>
      )}
      {message && stream && <p className="screen-share-message">{message}</p>}
      {status === 'error' && <p className="screen-share-error" role="alert">{message}</p>}
      <button type="button" className={shareId ? 'screen-share-stop' : 'screen-share-start'} onClick={shareId ? () => void stop() : () => void start()} disabled={status === 'requesting' || (!shareId && !available)}>
        {shareId ? <><Square size={15} /> Stop viewing</> : <><MonitorUp size={15} /> {status === 'requesting' ? 'Requesting…' : 'Request screen share'}</>}
      </button>
      {!available && <small className="screen-share-hint">The paired Windows Agent must be online.</small>}
    </section>
  );
}
