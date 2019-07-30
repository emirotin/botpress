import {
  BotFrameworkAdapter,
  ConversationReference,
  CardFactory,
  TurnContext,
  AttachmentLayoutTypes,
  Activity
} from 'botbuilder'

import * as sdk from 'botpress/sdk'
import { Router } from 'express'
import _ from 'lodash'

import { Config } from '../config'

import { Clients } from './typings'

const outgoingTypes = ['message', 'typing', 'carousel', 'text']

export class TeamsClient {
  private inMemoryConversationRefs: _.Dictionary<Partial<ConversationReference>> = {}
  private adapter: BotFrameworkAdapter
  constructor(
    private bp: typeof sdk,
    private botId: string,
    private config: Config,
    private router: Router & sdk.http.RouterExtension
  ) {}

  async initialize() {
    this.adapter = new BotFrameworkAdapter({
      appId: this.config.microsoftAppId,
      appPassword: this.config.microsoftAppPassword
    })

    const publicPath = await this.router.getPublicPath()
    if (publicPath.indexOf('https://') !== 0) {
      this.bp.logger.warn('Teams requires HTTPS to be setup to work properly. See EXTERNAL_URL botpress config.')
    }

    this.router.post('/api/messages', async (req, res) => {
      await this.adapter.processActivity(req, res, async turnContext => {
        const { activity } = turnContext

        const conversationReference = TurnContext.getConversationReference(activity)
        if (!activity.text) {
          // To prevent from emojis reactions to launch actual events
          return
        }

        const threadId = conversationReference.conversation.id
        await this._setConversationRef(threadId, conversationReference)

        this._sendIncomingEvent(activity, threadId)
      })
    })
  }

  private async _getConversationRef(threadId: string): Promise<Partial<ConversationReference>> {
    let convRef = this.inMemoryConversationRefs[threadId]
    if (convRef) {
      return convRef
    }

    // cache miss
    convRef = await this.bp.kvs.get(this.botId, threadId)
    this.inMemoryConversationRefs[threadId] = convRef
    return convRef
  }

  private async _setConversationRef(threadId: string, convRef: Partial<ConversationReference>): Promise<void> {
    if (this.inMemoryConversationRefs[threadId]) {
      return
    }

    this.inMemoryConversationRefs[threadId] = convRef
    return this.bp.kvs.set(this.botId, threadId, convRef)
  }

  private _sendIncomingEvent = (activity: Activity, threadId: string) => {
    const { text, from, type } = activity

    this.bp.events.sendEvent(
      this.bp.IO.Event({
        botId: this.botId,
        channel: 'teams',
        direction: 'incoming',
        payload: { text },
        preview: text,
        threadId,
        target: from.id,
        type
      })
    )
  }

  public async sendOutgoingEvent(event: sdk.IO.Event): Promise<void> {
    const messageType = event.type === 'default' ? 'text' : event.type

    if (!_.includes(outgoingTypes, messageType)) {
      throw new Error('Unsupported event type: ' + event.type)
    }

    const ref = await this._getConversationRef(event.threadId)
    if (!ref) {
      this.bp.logger.warn(
        `No message could be sent to MS Botframework with threadId: ${
          event.threadId
        } as there is no conversation reference`
      )
      return
    }

    let msg: any = event.payload // TODO: place this logic in builtin with content-types
    if (msg.type === 'typing') {
      msg = {
        type: 'typing'
      }
    } else if (msg.type === 'carousel') {
      msg = this._prepareCarouselPayload(event)
    } else if (msg.quick_replies && msg.quick_replies.length) {
      msg = this._prepareChoicePayload(event)
    }

    await this.adapter.continueConversation(ref, async (turnContext: TurnContext) => {
      try {
        await turnContext.sendActivity(msg)
      } catch (err) {
        const message = `The following error occured when sending a payload of type ${msg.type} to MS Botframework: ${
          err.message
        }`
        this.bp.logger.error(message, err)
        throw err
      }
    })
  }

  private _prepareChoicePayload(event: sdk.IO.Event) {
    return {
      text: event.payload.text,
      attachments: [
        CardFactory.heroCard(
          '',
          CardFactory.images([]),
          CardFactory.actions(
            event.payload.quick_replies.map(reply => {
              return {
                title: reply.title,
                type: 'messageBack',
                value: reply.payload,
                text: reply.payload,
                displayText: reply.title
              }
            })
          )
        )
      ]
    }
  }

  private _prepareCarouselPayload(event: sdk.IO.Event) {
    return {
      type: 'message',
      attachments: event.payload.elements.map(card => {
        let contentUrl = card.picture

        return CardFactory.heroCard(
          card.title,
          CardFactory.images([contentUrl]),
          CardFactory.actions(
            card.buttons.map(button => {
              if (button.type === 'open_url') {
                return {
                  type: 'openUrl',
                  value: button.url,
                  title: button.title
                }
              } else if (button.type === 'say_something') {
                return {
                  type: 'messageBack',
                  title: button.title,
                  value: button.text,
                  text: button.text,
                  displayText: button.text
                }
              } else if (button.type === 'postback') {
                return {
                  type: 'messageBack',
                  title: button.title,
                  value: button.payload,
                  text: button.payload
                }
              }
            })
          )
        )
      }),
      attachmentLayout: AttachmentLayoutTypes.Carousel
    }
  }
}

export async function setupMiddleware(bp: typeof sdk, clients: Clients) {
  bp.events.registerMiddleware({
    description:
      'Sends out messages that targets platform = teams.' +
      ' This middleware should be placed at the end as it swallows events once sent.',
    direction: 'outgoing',
    handler: outgoingHandler(clients),
    name: 'teams.sendMessages',
    order: 100
  })
}

const outgoingHandler = (clients: Clients) => async (event: sdk.IO.Event, next: sdk.IO.MiddlewareNextCallback) => {
  if (event.channel !== 'teams') {
    return next()
  }

  const client: TeamsClient = clients[event.botId]
  if (!client) {
    return next()
  }

  try {
    await client.sendOutgoingEvent(event)
  } catch (err) {
    next(err)
  }

  next(undefined, false)
}
