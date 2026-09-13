import { assert } from '../errors.mjs';

export class ProfileRegistry {
  constructor(profiles = []) {
    this.profiles = new Map();
    for (const profile of profiles) this.register(profile);
  }

  register(profile) {
    assert(profile?.id && profile?.version, 'PROFILE_INVALID', 'A Profile requires id and version.');
    for (const method of ['validateConfig', 'validateRun', 'canDispatch', 'canClose', 'project']) assert(typeof profile[method] === 'function', 'PROFILE_CONTRACT_INVALID', `Profile ${profile.id} is missing ${method}.`);
    assert(!this.profiles.has(profile.id), 'PROFILE_DUPLICATE', `Profile already registered: ${profile.id}`);
    this.profiles.set(profile.id, Object.freeze(profile));
    return profile;
  }

  get(id) { return this.profiles.get(id); }
  list() { return [...this.profiles.values()].map(profile => ({ id: profile.id, version: profile.version })); }
}
