const createHash = require('create-hash/browser')
import { CognitoIdentityServiceProvider } from 'aws-sdk'
import { profile } from '@affinidi/tools-common'

import { CognitoUserTokens, MessageParameters } from './dto'

type Response<TResult, TSuccessResult extends TResult, TAdditionalSuccessFields> =
  | { result: Exclude<TResult, TSuccessResult> }
  | ({ result: TSuccessResult } & TAdditionalSuccessFields)

export enum SignUpResult {
  Success,
  UnconfirmedUsernameExists,
  ConfirmedUsernameExists,
  InvalidPassword,
}

export enum LogInWithPasswordResult {
  Success,
  UserNotFound,
  UserNotConfirmed,
}

type LogInWithPasswordResponse = Response<
  LogInWithPasswordResult,
  LogInWithPasswordResult.Success,
  { cognitoTokens: CognitoUserTokens }
>

export enum CompleteLoginPasswordlessResult {
  Success,
  AttemptsExceeded,
  ConfirmationCodeExpired,
  ConfirmationCodeWrong,
}

type CompleteLoginPasswordlessResponse = Response<
  CompleteLoginPasswordlessResult,
  CompleteLoginPasswordlessResult.Success | CompleteLoginPasswordlessResult.ConfirmationCodeWrong,
  { cognitoTokens: CognitoUserTokens; token: string }
>

export enum InitiateLoginPasswordlessResult {
  Success,
  UserNotFound,
}

type InitiateLoginPasswordlessResponse = Response<
  InitiateLoginPasswordlessResult,
  InitiateLoginPasswordlessResult.Success,
  { token: string }
>

export enum InitiateForgotPasswordResult {
  Success,
  UserNotFound,
}

export enum CompleteForgotPasswordResult {
  Success,
  UserNotFound,
  ConfirmationCodeExpired,
  ConfirmationCodeWrong,
  NewPasswordInvalid,
}

export enum ResendSignUpResult {
  Success,
  UserNotFound,
  UserAlreadyConfirmed,
}

export enum CompleteSignUpResult {
  Success,
  UserNotFound,
  ConfirmationCodeExpired,
  ConfirmationCodeWrong,
}

export enum InitiateChangeLoginResult {
  Success,
  NewLoginExists,
}

export enum CompleteChangeLoginResult {
  Success,
  ConfirmationCodeExpired,
  ConfirmationCodeWrong,
}

enum AuthFlow {
  UserPassword = 'USER_PASSWORD_AUTH',
  Custom = 'CUSTOM_AUTH',
  RefreshToken = 'REFRESH_TOKEN_AUTH',
}

export type UsernameWithAttributes = {
  normalizedUsername: string
  login: string
  phoneNumber?: string
  emailAddress?: string
}

const getAdditionalParameters = (messageParameters?: MessageParameters) => {
  return messageParameters ? { ClientMetadata: messageParameters as Record<string, any> } : {}
}
const sha256 = (data: string): string =>
  createHash('sha256')
    .update(data || '')
    .digest()
    .toString('base64')

/* TODO: NUC-270 we should design stateless flow or use external configurable storage .
 Storing session in memory won't work in case of scaling (> 1 pod).
 Shared Redis can be a solution.
 */
const tempSession: Record<string, string> = {}
const INVALID_PASSWORD = '1'

/**
 * @internal
 */
@profile()
export class CognitoIdentityService {
  private readonly clientId
  private readonly cognitoidentityserviceprovider

  constructor({ region, clientId }: { region: string; clientId: string }) {
    this.clientId = clientId
    this.cognitoidentityserviceprovider = new CognitoIdentityServiceProvider({
      region,
      apiVersion: '2016-04-18',
    })
  }

  async tryLogInWithPassword(login: string, password: string): Promise<LogInWithPasswordResponse> {
    try {
      const params = this._getCognitoAuthParametersObject(AuthFlow.UserPassword, login, password)
      const { AuthenticationResult } = await this.cognitoidentityserviceprovider.initiateAuth(params).promise()
      const cognitoTokens = this._normalizeTokensFromCognitoAuthenticationResult(AuthenticationResult)

      return {
        result: LogInWithPasswordResult.Success,
        cognitoTokens,
      }
    } catch (error) {
      switch (error.code) {
        case 'UserNotFoundException':
          return { result: LogInWithPasswordResult.UserNotFound }
        case 'UserNotConfirmedException':
          return { result: LogInWithPasswordResult.UserNotConfirmed }
        default:
          throw error
      }
    }
  }

  async initiateLogInPasswordless(
    login: string,
    messageParameters?: MessageParameters,
  ): Promise<InitiateLoginPasswordlessResponse> {
    const params = {
      ...this._getCognitoAuthParametersObject(AuthFlow.Custom, login),
      ...getAdditionalParameters(messageParameters),
    }

    try {
      const response = await this.cognitoidentityserviceprovider.initiateAuth(params).promise()
      const token = JSON.stringify(response)
      return { result: InitiateLoginPasswordlessResult.Success, token }
    } catch (error) {
      if (error.code === 'UserNotFoundException') {
        return { result: InitiateLoginPasswordlessResult.UserNotFound }
      } else {
        throw error
      }
    }
  }

  async completeLogInPasswordless(token: string, confirmationCode: string): Promise<CompleteLoginPasswordlessResponse> {
    const tokenObject = JSON.parse(token)
    const { Session: tokenSession, ChallengeName, ChallengeParameters } = tokenObject
    //TODO: session is approx 920 character long string
    const hashedTokenSession = sha256(tokenSession)
    const Session = tempSession[hashedTokenSession] || tokenSession

    const params = {
      ClientId: this.clientId,
      ChallengeName,
      ChallengeResponses: {
        ...ChallengeParameters,
        ANSWER: confirmationCode,
      },
      Session,
    }

    try {
      const result = await this.cognitoidentityserviceprovider.respondToAuthChallenge(params).promise()
      //NOTE : successful OTP return a undefined session . wrong code return a new session
      tempSession[hashedTokenSession] = result.Session
      // NOTE: respondToAuthChallenge for the custom auth flow do not return
      //       error, but if response has `ChallengeName` - it is an error
      if (result.ChallengeName === 'CUSTOM_CHALLENGE') {
        return {
          result: CompleteLoginPasswordlessResult.ConfirmationCodeWrong,
          cognitoTokens: null,
          token: JSON.stringify({ ...tokenObject, Session: result.Session }),
        }
      }

      const cognitoTokens = this._normalizeTokensFromCognitoAuthenticationResult(result.AuthenticationResult)
      //TODO : we still need to think about clean up for sessions that was not finished by user. ex. session was confirmed with wrong pasword 1 or 2 times with out sucess.
      // potential memory leak.
      delete tempSession[hashedTokenSession]
      return { result: CompleteLoginPasswordlessResult.Success, cognitoTokens, token: null }
    } catch (error) {
      // NOTE: not deleted sessions after any errors will block user session
      delete tempSession[hashedTokenSession]

      // NOTE: Incorrect username or password. -> Corresponds to custom auth challenge
      //       error when OTP was entered incorrectly 3 times.
      if (error.message === 'Incorrect username or password.') {
        return { result: CompleteLoginPasswordlessResult.AttemptsExceeded }
      } else if (error.code === 'NotAuthorizedException') {
        // Throw when OTP is expired (3 min)
        return { result: CompleteLoginPasswordlessResult.ConfirmationCodeExpired }
      } else {
        throw error
      }
    }
  }

  // NOTE: Signs out users from all devices. It also invalidates all
  //       refresh tokens issued to a user. The user's current access and
  //       Id tokens remain valid until their expiry.
  //       Access and Id tokens expire one hour after they are issued.
  async logOut(AccessToken: string): Promise<void> {
    this.cognitoidentityserviceprovider.globalSignOut({ AccessToken })
  }

  async initiateForgotPassword(
    login: string,
    messageParameters?: MessageParameters,
  ): Promise<InitiateForgotPasswordResult> {
    const params = {
      ClientId: this.clientId,
      Username: login,
      ...getAdditionalParameters(messageParameters),
    }

    try {
      await this.cognitoidentityserviceprovider.forgotPassword(params).promise()

      return InitiateForgotPasswordResult.Success
    } catch (error) {
      if (error.code === 'UserNotFoundException') {
        return InitiateForgotPasswordResult.UserNotFound
      } else {
        throw error
      }
    }
  }

  async completeForgotPassword(
    login: string,
    confirmationCode: string,
    password: string,
  ): Promise<CompleteForgotPasswordResult> {
    const params = {
      ClientId: this.clientId,
      Password: password,
      Username: login,
      ConfirmationCode: confirmationCode,
    }

    try {
      await this.cognitoidentityserviceprovider.confirmForgotPassword(params).promise()

      return CompleteForgotPasswordResult.Success
    } catch (error) {
      switch (error.code) {
        case 'ExpiredCodeException':
          return CompleteForgotPasswordResult.ConfirmationCodeExpired
        case 'UserNotFoundException':
          return CompleteForgotPasswordResult.UserNotFound
        case 'CodeMismatchException':
          return CompleteForgotPasswordResult.ConfirmationCodeWrong
        case 'InvalidPasswordException':
          return CompleteForgotPasswordResult.NewPasswordInvalid
        default:
          throw error
      }
    }
  }

  async trySignUp(
    usernameWithAttributes: UsernameWithAttributes,
    password: string,
    messageParameters?: MessageParameters,
  ): Promise<SignUpResult> {
    const params = {
      ClientId: this.clientId,
      Password: password,
      Username: usernameWithAttributes.normalizedUsername,
      UserAttributes: this._buildUserAttributes(usernameWithAttributes),
      ...getAdditionalParameters(messageParameters),
    }

    try {
      await this.cognitoidentityserviceprovider.signUp(params).promise()
      return SignUpResult.Success
    } catch (error) {
      switch (error.code) {
        case 'UsernameExistsException': {
          const isUserUnconfirmed = await this.doesUnconfirmedUserExist(usernameWithAttributes.normalizedUsername)
          return isUserUnconfirmed ? SignUpResult.UnconfirmedUsernameExists : SignUpResult.ConfirmedUsernameExists
        }

        case 'InvalidPasswordException':
          return SignUpResult.InvalidPassword

        default:
          throw error
      }
    }
  }

  async resendSignUp(
    usernameWithAttributes: UsernameWithAttributes,
    messageParameters?: MessageParameters,
  ): Promise<ResendSignUpResult> {
    const params = {
      ClientId: this.clientId,
      Username: usernameWithAttributes.normalizedUsername,
      ...getAdditionalParameters(messageParameters),
    }

    try {
      await this.cognitoidentityserviceprovider.resendConfirmationCode(params).promise()
      return ResendSignUpResult.Success
    } catch (error) {
      switch (error.code) {
        case 'UserNotFoundException':
          return ResendSignUpResult.UserNotFound
        case 'InvalidParameterException':
          return ResendSignUpResult.UserAlreadyConfirmed
        default:
          throw error
      }
    }
  }

  async completeSignUp(
    usernameWithAttributes: UsernameWithAttributes,
    confirmationCode: string,
  ): Promise<CompleteSignUpResult> {
    const params = {
      ClientId: this.clientId,
      Username: usernameWithAttributes.normalizedUsername,
      ConfirmationCode: confirmationCode,
    }

    try {
      await this.cognitoidentityserviceprovider.confirmSignUp(params).promise()
      return CompleteSignUpResult.Success
    } catch (error) {
      switch (error.code) {
        case 'UserNotFoundException':
          return CompleteSignUpResult.UserNotFound
        case 'ExpiredCodeException':
          return CompleteSignUpResult.ConfirmationCodeExpired
        case 'CodeMismatchException':
          return CompleteSignUpResult.ConfirmationCodeWrong
        default:
          throw error
      }
    }
  }

  async changePassword(AccessToken: string, PreviousPassword: string, ProposedPassword: string) {
    const params = { AccessToken, PreviousPassword, ProposedPassword }

    return this.cognitoidentityserviceprovider.changePassword(params).promise()
  }

  async initiateChangeAttributes(
    accessToken: string,
    usernameWithAttributes: UsernameWithAttributes,
    messageParameters?: MessageParameters,
  ): Promise<InitiateChangeLoginResult> {
    const usernameExists = await this._userExists(usernameWithAttributes.normalizedUsername)
    const loginExists = await this._userExists(usernameWithAttributes.login)

    if (usernameExists || loginExists) {
      return InitiateChangeLoginResult.NewLoginExists
    }

    const params = {
      AccessToken: accessToken,
      UserAttributes: this._buildUserAttributes(usernameWithAttributes),
      ...getAdditionalParameters(messageParameters),
    }

    await this.cognitoidentityserviceprovider.updateUserAttributes(params).promise()
    return InitiateChangeLoginResult.Success
  }

  private async _completeChangeAttributes(
    accessToken: string,
    attributeName: string,
    confirmationCode: string,
  ): Promise<CompleteChangeLoginResult> {
    const params = {
      AccessToken: accessToken,
      AttributeName: attributeName,
      Code: confirmationCode,
    }

    try {
      await this.cognitoidentityserviceprovider.verifyUserAttribute(params).promise()
      return CompleteChangeLoginResult.Success
    } catch (error) {
      switch (error.code) {
        case 'ExpiredCodeException':
          return CompleteChangeLoginResult.ConfirmationCodeExpired
        case 'CodeMismatchException':
          return CompleteChangeLoginResult.ConfirmationCodeWrong
        default:
          throw error
      }
    }
  }

  async completeChangeEmail(accessToken: string, confirmationCode: string): Promise<CompleteChangeLoginResult> {
    return this._completeChangeAttributes(accessToken, 'email', confirmationCode)
  }

  async completeChangePhone(accessToken: string, confirmationCode: string): Promise<CompleteChangeLoginResult> {
    return this._completeChangeAttributes(accessToken, 'phone_number', confirmationCode)
  }

  async doesUnconfirmedUserExist(normalizedUsername: string): Promise<boolean> {
    const { isUnconfirmed } = await this._logInWithInvalidPassword(normalizedUsername)

    return isUnconfirmed
  }

  async doesConfirmedUserExist(normalizedUsername: string): Promise<boolean> {
    const { userExists, isUnconfirmed } = await this._logInWithInvalidPassword(normalizedUsername)

    return userExists && !isUnconfirmed
  }

  private _getAuthParametersObject(authFlow: AuthFlow, login: string, password: string, refreshToken: string) {
    switch (authFlow) {
      case AuthFlow.UserPassword:
        return { USERNAME: login, PASSWORD: password }
      case AuthFlow.Custom:
        return { USERNAME: login }
      case AuthFlow.RefreshToken:
        return { REFRESH_TOKEN: refreshToken }
    }
  }

  private _getCognitoAuthParametersObject(
    authFlow: AuthFlow,
    login: string = null,
    password: string = null,
    refreshToken: string = null,
  ) {
    return {
      AuthFlow: authFlow as string,
      ClientId: this.clientId,
      AuthParameters: this._getAuthParametersObject(authFlow, login, password, refreshToken),
    }
  }

  private _normalizeTokensFromCognitoAuthenticationResult(
    AuthenticationResult: AWS.CognitoIdentityServiceProvider.AuthenticationResultType,
  ): CognitoUserTokens {
    const { AccessToken: accessToken, IdToken: idToken, RefreshToken: refreshToken, ExpiresIn } = AuthenticationResult

    // NOTE: ExpiresIn = 3600, in seconds which is 1h
    const expiresIn = Date.now() + ExpiresIn * 1000

    return { accessToken, idToken, refreshToken, expiresIn }
  }

  public async logInWithRefreshToken(token: string): Promise<CognitoUserTokens> {
    const params = this._getCognitoAuthParametersObject(AuthFlow.RefreshToken, token)
    console.log('params', params)
    const { AuthenticationResult } = await this.cognitoidentityserviceprovider.initiateAuth(params).promise()
    const cognitoUserTokens = this._normalizeTokensFromCognitoAuthenticationResult(AuthenticationResult)
    return cognitoUserTokens
  }

  private _buildUserAttributes({ phoneNumber, emailAddress }: UsernameWithAttributes) {
    return [
      ...(emailAddress ? [{ Name: 'email', Value: emailAddress }] : []),
      ...(phoneNumber ? [{ Name: 'phone_number', Value: phoneNumber }] : []),
    ]
  }

  private async _logInWithInvalidPassword(username: string) {
    try {
      const response = await this.tryLogInWithPassword(username, INVALID_PASSWORD)
      switch (response.result) {
        case LogInWithPasswordResult.UserNotFound:
          return { userExists: false, isUnconfirmed: false }
        case LogInWithPasswordResult.UserNotConfirmed:
          return { userExists: true, isUnconfirmed: true }
        default:
          return { userExists: true, isUnconfirmed: false }
      }
    } catch (error) {
      return { userExists: true, isUnconfirmed: false }
    }
  }

  private async _userExists(username: string): Promise<boolean> {
    const { userExists } = await this._logInWithInvalidPassword(username)

    return userExists
  }
}
