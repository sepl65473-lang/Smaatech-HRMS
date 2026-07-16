import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep a trace for debugging; swap with a logging service later.
    console.error('HRMS crashed:', error, info?.componentStack);
  }

  handleReload = () => {
    this.setState({ error: null });
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: 24, fontFamily: 'inherit',
      }}>
        <div className="card" style={{ maxWidth: 460, textAlign: 'center', padding: 32 }}>
          <div className="card-title" style={{ marginBottom: 8 }}>Something went wrong</div>
          <p className="muted-text" style={{ marginBottom: 8 }}>
            The app hit an unexpected error. Your data is safe — it lives in this browser.
          </p>
          <p className="mono" style={{ fontSize: 12, opacity: 0.7, marginBottom: 20, wordBreak: 'break-word' }}>
            {String(this.state.error?.message || this.state.error)}
          </p>
          <button className="btn" onClick={this.handleReload}>Reload workspace</button>
        </div>
      </div>
    );
  }
}
