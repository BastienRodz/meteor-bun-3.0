import { Accounts } from 'meteor/accounts-base';
import twofactor from 'node-2fa';
import QRCode from 'qrcode-svg';
import { Meteor } from 'meteor/meteor';

Accounts.is2faEnabledForUser = selector => {
  if (!Meteor.isServer) {
    throw new Meteor.Error(
      400,
      'The function is2faEnabledForUser can only be called on the server'
    );
  }

  if (typeof selector === 'string') {
    if (!selector.includes('@')) {
      selector = { username: selector };
    } else {
      selector = { email: selector };
    }
  }

  const user = Meteor.users.findOne(selector) || {};
  const { twoFactorAuthentication } = user;
  return (
    twoFactorAuthentication &&
    twoFactorAuthentication.secret &&
    twoFactorAuthentication.type === 'otp'
  );
};

Accounts.generate2faToken = secret => twofactor.generateToken(secret);

Accounts.isTokenValid = (secret, token) => {
  if (!Meteor.isServer) {
    throw new Meteor.Error(
      400,
      'The function isTokenValid can only be called on the server'
    );
  }
  const { delta } = twofactor.verifyToken(secret, token, 10) || {};
  return delta != null && delta >= 0;
};

Meteor.methods({
  generate2faActivationQrCode(appName) {
    const user = Meteor.user();

    if (!user) {
      return null;
    }

    const { username } = user;

    const { secret, uri } = twofactor.generateSecret({
      name: typeof appName === 'string' ? appName : undefined,
      account: username,
    });
    const svg = new QRCode(uri).svg();

    Meteor.users.update(
      { username },
      {
        $set: {
          twoFactorAuthentication: {
            secret,
          },
        },
      }
    );

    return svg;
  },
  enableUser2fa(code) {
    const user = Meteor.user();

    if (!user) {
      throw new Meteor.Error(400, 'No user logged in.');
    }

    const { twoFactorAuthentication, username } = user;

    if (!twoFactorAuthentication || !twoFactorAuthentication.secret) {
      throw new Meteor.Error(
        500,
        'The user does not have a secret generated. You may have to call the function generateSvgCode first.'
      );
    }
    if (!Accounts.isTokenValid(twoFactorAuthentication.secret, code)) {
      throw new Meteor.Error(400, 'Invalid token.');
    }

    Meteor.users.update(
      { username },
      {
        $set: {
          twoFactorAuthentication: {
            ...twoFactorAuthentication,
            type: 'otp',
          },
        },
      }
    );
  },
  disableUser2fa() {
    const user = Meteor.user();

    if (!user) {
      throw new Meteor.Error(400, 'No user logged in.');
    }

    Meteor.users.update(
      { username: user.username },
      {
        $unset: {
          twoFactorAuthentication: 1,
        },
      }
    );
  },
  has2faEnabled(selector) {
    return Accounts.is2faEnabledForUser(selector);
  },
});
