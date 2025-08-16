import { PreprocessProvider } from '@types'

import BasePreprocessProvider from './BasePreprocessProvider'
import DefaultPreprocessProvider from './DefaultPreprocessProvider'
import Doc2xPreprocessProvider from './Doc2xPreprocessProvider'
import MineruPreprocessProvider from './MineruPreprocessProvider'
import MistralPreprocessProvider from './MistralPreprocessProvider'
import MineruLocalPreprocessProvider from './MineruLocalPreprocessProvider'
import DotsOcrPreprocessProvider from './DotsOcrPreprocessProvider'
export default class PreprocessProviderFactory {
  static create(provider: PreprocessProvider, userId?: string): BasePreprocessProvider {
    switch (provider.id) {
      case 'doc2x':
        return new Doc2xPreprocessProvider(provider)
      case 'mistral':
        return new MistralPreprocessProvider(provider)
      case 'mineru':
        return new MineruPreprocessProvider(provider, userId)
      case 'mineru_local':
        return new MineruLocalPreprocessProvider(provider, userId)
      case 'dots_ocr':
        return new DotsOcrPreprocessProvider(provider, userId)
      default:
        return new DefaultPreprocessProvider(provider)
    }
  }
}
