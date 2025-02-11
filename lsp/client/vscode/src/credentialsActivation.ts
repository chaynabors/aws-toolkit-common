import { fromIni } from '@aws-sdk/credential-providers'
import { AwsCredentialIdentity } from '@aws-sdk/types'
import * as crypto from 'crypto'
import * as jose from 'jose'
import { Writable } from 'stream'
import { ExtensionContext, commands, window } from 'vscode'
import { LanguageClient, LanguageClientOptions, NotificationType } from 'vscode-languageclient/node'

/**
 * Request for custom notifications that Update Credentials and tokens.
 * See core\aws-lsp-core\src\credentials\updateCredentialsRequest.ts for details
 */
export interface UpdateCredentialsRequest {
    /**
     * Encrypted token (JWT or PASETO)
     * The token's contents differ whether IAM or Bearer token is sent
     */
    data: string
}

export interface UpdateIamCredentialsRequestData {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
}

const encryptionKey = crypto.randomBytes(32)

// See core\aws-lsp-core\src\credentials\credentialsProvider.ts for the server's
// custom method names and intents.
const lspMethodNames = {
    iamCredentialsUpdate: '$/aws/credentials/iam/update',
    iamCredentialsDelete: '$/aws/credentials/iam/delete',
}

const notificationTypes = {
    updateIamCredentials: new NotificationType<UpdateCredentialsRequest>(lspMethodNames.iamCredentialsUpdate),
    deleteIamCredentials: new NotificationType(lspMethodNames.iamCredentialsDelete),
}

/**
 * Sends a json payload to the language server, who is waiting to know what the encryption key is.
 */
export function writeEncryptionInit(stream: Writable): void {
    const request = {
        version: '1.0',
        mode: 'JWT',
        key: encryptionKey.toString('base64'),
    }
    stream.write(JSON.stringify(request))
    stream.write('\n')
}

/**
 * Updates the language client's initialization payload to indicate that it can provide credentials
 * for AWS language servers.
 */
export function configureCredentialsCapabilities(clientOptions: LanguageClientOptions) {
    if (!clientOptions.initializationOptions) {
        clientOptions.initializationOptions = {}
    }

    // This is how we configure the behavior of AWS Language Servers.
    // The structure needs to be formalized across all AWS hosts/extensions.
    //
    // This structure is exploration/conceptual/speculative at this time.
    // See lsp\core\aws-lsp-core\src\initialization\awsInitializationOptions.ts
    clientOptions.initializationOptions.credentials = {
        providesIam: true,
    }
}

export async function registerIamCredentialsProviderSupport(
    languageClient: LanguageClient,
    extensionContext: ExtensionContext
): Promise<void> {
    extensionContext.subscriptions.push(
        ...[
            commands.registerCommand('awslsp.selectProfile', createSelectProfileCommand(languageClient)),
            commands.registerCommand('awslsp.clearProfile', createClearProfileCommand(languageClient)),
        ]
    )
}

/**
 * This command simulates an extension's credentials state changing, and pushing updated
 * credentials to the server.
 *
 * In this simulation, the user is asked for a profile name. That profile's credentials are
 * resolved and sent. (basic profile types only in this proof of concept)
 */
function createSelectProfileCommand(languageClient: LanguageClient) {
    return async () => {
        const profileName = await window.showInputBox({
            prompt: 'Which credentials profile should the language server use?',
        })

        // PROOF OF CONCEPT
        // We will resolve the default profile from the local system.
        // In a product, the host extension would know which profile it is configured to provide to the language server.
        const awsCredentials = await fromIni({
            profile: profileName,
        })()

        const request = await createUpdateIamCredentialsRequest(awsCredentials)
        await sendIamCredentialsUpdate(request, languageClient)

        languageClient.info(`Client: The language server is now using credentials profile: ${profileName}`)
    }
}

/**
 * Creates an "update credentials" request that contains encrypted data
 */
async function createUpdateIamCredentialsRequest(
    awsCredentials: AwsCredentialIdentity
): Promise<UpdateCredentialsRequest> {
    const requestData: UpdateIamCredentialsRequestData = {
        accessKeyId: awsCredentials.accessKeyId,
        secretAccessKey: awsCredentials.secretAccessKey,
        sessionToken: awsCredentials.sessionToken,
    }

    const payload = new TextEncoder().encode(
        JSON.stringify({
            data: requestData,
        })
    )

    const jwt = await new jose.CompactEncrypt(payload)
        .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
        .encrypt(encryptionKey)

    return {
        data: jwt,
    }
}

function sendIamCredentialsUpdate(request: UpdateCredentialsRequest, languageClient: LanguageClient): Promise<void> {
    return languageClient.sendNotification(notificationTypes.updateIamCredentials, request)
}

/**
 * This command simulates an extension's credentials expiring (or the user configuring "no credentials").
 *
 * The server's credentials are cleared.
 */
function createClearProfileCommand(languageClient: LanguageClient) {
    return async () => {
        await languageClient.sendNotification(notificationTypes.deleteIamCredentials)
    }
}
