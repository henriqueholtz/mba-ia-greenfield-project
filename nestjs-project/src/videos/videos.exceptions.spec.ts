import { ArgumentsHost } from '@nestjs/common';
import { DomainExceptionFilter } from '../common/filters/domain-exception.filter';
import {
  VideoAlreadyProcessedException,
  VideoForbiddenException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';

interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: unknown;
}

describe('Video domain exceptions', () => {
  let filter: DomainExceptionFilter;
  let mockJson: jest.Mock<void, [ErrorResponseBody]>;
  let mockStatus: jest.Mock<{ json: typeof mockJson }, [number]>;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new DomainExceptionFilter();
    mockJson = jest.fn<void, [ErrorResponseBody]>();
    mockStatus = jest
      .fn<{ json: typeof mockJson }, [number]>()
      .mockReturnValue({ json: mockJson });

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({ url: '/test', method: 'GET' }),
      }),
      getArgs: () => [],
      getArgByIndex: () => null,
      switchToRpc: () => ({}) as ReturnType<ArgumentsHost['switchToRpc']>,
      switchToWs: () => ({}) as ReturnType<ArgumentsHost['switchToWs']>,
      getType: () => 'http',
    } as unknown as ArgumentsHost;
  });

  it('maps VideoNotFoundException to 404 with VIDEO_NOT_FOUND', () => {
    filter.catch(new VideoNotFoundException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(404);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 404,
      error: 'VIDEO_NOT_FOUND',
      message: expect.any(String) as unknown as string,
    });
  });

  it('maps VideoForbiddenException to 403 with VIDEO_FORBIDDEN', () => {
    filter.catch(new VideoForbiddenException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(403);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 403,
      error: 'VIDEO_FORBIDDEN',
      message: expect.any(String) as unknown as string,
    });
  });

  it('maps VideoAlreadyProcessedException to 409 with VIDEO_ALREADY_PROCESSED', () => {
    filter.catch(new VideoAlreadyProcessedException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'VIDEO_ALREADY_PROCESSED',
      message: expect.any(String) as unknown as string,
    });
  });

  it('maps VideoNotReadyException to 409 with VIDEO_NOT_READY', () => {
    filter.catch(new VideoNotReadyException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'VIDEO_NOT_READY',
      message: expect.any(String) as unknown as string,
    });
  });
});
