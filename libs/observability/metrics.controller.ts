import { Controller } from '@nestjs/common'
import { PrometheusController } from '@willsoto/nestjs-prometheus'

/**
 * Prometheus metrics endpoint.
 * GET /metrics — returns all registered prom-client metrics in text/plain format.
 * Consumed by a Prometheus scraper; never expose publicly without auth.
 */
@Controller('metrics')
export class MetricsController extends PrometheusController {}
