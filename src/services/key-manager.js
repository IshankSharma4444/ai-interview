class KeyManager {
  constructor() {
    this.keys = {
      groq: [],
      gemini: [],
      openai: []
    };
    this.cooldowns = new Map();
    this.invalid = new Map();
  }

  setKeys(provider, keys) {
    if (!this.keys[provider]) this.keys[provider] = [];
    this.keys[provider] = (Array.isArray(keys) ? keys : []).map((k) => ({
      id: k.id || `${provider}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      value: k.value || k.key || '',
      enabled: k.enabled !== false
    })).filter((k) => k.value);
  }

  getKeysStatus(provider) {
    const list = this.keys[provider] || [];
    return list.map((k) => ({
      id: k.id,
      enabled: k.enabled,
      masked: k.value ? `${k.value.slice(0, 4)}...${k.value.slice(-4)}` : '',
      cooldownUntil: this.cooldowns.get(`${provider}:${k.id}`) || 0,
      invalid: this.invalid.has(`${provider}:${k.id}`)
    }));
  }

  getUsableKey(provider) {
    const now = Date.now();
    const list = (this.keys[provider] || []).filter((k) => k.enabled);
    for (const k of list) {
      const cd = this.cooldowns.get(`${provider}:${k.id}`) || 0;
      if (cd > now) continue;
      if (this.invalid.has(`${provider}:${k.id}`)) continue;
      return k;
    }
    return null;
  }

  markRateLimited(provider, keyId, retryAfterSeconds) {
    const ms = (retryAfterSeconds && retryAfterSeconds > 0) ? retryAfterSeconds * 1000 : 60000;
    this.cooldowns.set(`${provider}:${keyId}`, Date.now() + ms);
  }

  markInvalid(provider, keyId) {
    this.invalid.set(`${provider}:${keyId}`, true);
  }

  markQuotaExhausted(provider, keyId) {
    this.cooldowns.set(`${provider}:${keyId}`, Date.now() + 3600000);
  }

  disableKey(provider, keyId) {
    const list = this.keys[provider] || [];
    const k = list.find((x) => x.id === keyId);
    if (k) k.enabled = false;
  }

  removeKey(provider, keyId) {
    if (!this.keys[provider]) return;
    this.keys[provider] = this.keys[provider].filter((x) => x.id !== keyId);
    this.cooldowns.delete(`${provider}:${keyId}`);
    this.invalid.delete(`${provider}:${keyId}`);
  }

  hasAnyUsable(provider) {
    return !!this.getUsableKey(provider);
  }
}

module.exports = { KeyManager };
