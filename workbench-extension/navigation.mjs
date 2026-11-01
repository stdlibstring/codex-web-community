export function withNativeNavigation(Header, { useEffect, useLocation, goBack }) {
  return function NativeNavigationHeader(props) {
    const { pathname } = useLocation();
    const back = props.onBack ?? goBack;
    useEffect(() => {
      const bridge = window.CodexNavigation;
      if (!bridge) return;
      const id = crypto.randomUUID();
      const send = (type, fields = {}) => bridge.postMessage(JSON.stringify({ type, id, ...fields }));
      bridge.onmessage = event => {
        if (event.data !== id) throw new Error('系统返回请求与当前页面不一致。');
        back();
        send('handled');
      };
      send('ready', { canGoBack: pathname !== '/' });
      return () => {
        bridge.onmessage = null;
        send('detached');
      };
    }, [pathname, back]);
    return Header(props);
  };
}
