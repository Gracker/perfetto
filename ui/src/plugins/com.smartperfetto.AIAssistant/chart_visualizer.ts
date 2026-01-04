/**
 * 图表可视化组件
 * 使用纯 SVG 绘制饼图、柱状图等
 */

import m from 'mithril';

export interface ChartData {
  type: 'pie' | 'bar' | 'histogram';
  data: ChartDataPoint[];
  title?: string;
}

export interface ChartDataPoint {
  label: string;
  value: number;
  percentage?: number;
  color?: string;
}

export interface ChartVisualizerAttrs {
  chartData: ChartData;
  width?: number;
  height?: number;
}

const COLORS = {
  primary: ['#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444', '#06b6d4'],
  text: 'var(--text)',
  textSecondary: 'var(--text-secondary)',
  border: 'var(--border)',
};

const STYLES = {
  container: {
    padding: '16px',
    background: 'var(--background)',
    borderRadius: '8px',
    border: '1px solid var(--border)',
  },
  title: {
    fontSize: '14px',
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: '16px',
  },
  legend: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '12px',
    marginTop: '16px',
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    color: COLORS.textSecondary,
  },
  legendColor: {
    width: '12px',
    height: '12px',
    borderRadius: '2px',
  },
};

export class ChartVisualizer implements m.ClassComponent<ChartVisualizerAttrs> {
  view(vnode: m.Vnode<ChartVisualizerAttrs>): m.Children {
    const { chartData, width = 400, height = 300 } = vnode.attrs;

    // 为数据点分配颜色
    const dataWithColors = chartData.data.map((d, idx) => ({
      ...d,
      color: d.color || COLORS.primary[idx % COLORS.primary.length],
    }));

    return m('div', { style: STYLES.container }, [
      chartData.title
        ? m('div', { style: STYLES.title }, chartData.title)
        : null,

      // SVG 图表
      chartData.type === 'pie'
        ? this.renderPieChart(dataWithColors, width, height)
        : chartData.type === 'bar'
        ? this.renderBarChart(dataWithColors, width, height)
        : this.renderHistogram(dataWithColors, width, height),

      // 图例
      m('div', { style: STYLES.legend },
        dataWithColors.map(d =>
          m('div', { style: STYLES.legendItem }, [
            m('div', {
              style: {
                ...STYLES.legendColor,
                background: d.color,
              },
            }),
            m('span', `${d.label}: ${d.value.toFixed(2)}${d.percentage ? ` (${d.percentage.toFixed(1)}%)` : ''}`),
          ])
        )
      ),
    ]);
  }

  /**
   * 渲染饼图
   */
  private renderPieChart(data: ChartDataPoint[], width: number, height: number): m.Children {
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) / 2 - 20;

    // 计算总值
    const total = data.reduce((sum, d) => sum + d.value, 0);

    // 计算每个扇形的角度
    let currentAngle = -90; // 从顶部开始

    const paths = data.map(d => {
      const percentage = (d.value / total) * 100;
      const angle = (percentage / 100) * 360;

      // 计算扇形路径
      const startAngle = (currentAngle * Math.PI) / 180;
      const endAngle = ((currentAngle + angle) * Math.PI) / 180;

      const x1 = centerX + radius * Math.cos(startAngle);
      const y1 = centerY + radius * Math.sin(startAngle);
      const x2 = centerX + radius * Math.cos(endAngle);
      const y2 = centerY + radius * Math.sin(endAngle);

      const largeArc = angle > 180 ? 1 : 0;

      const pathData = [
        `M ${centerX} ${centerY}`,
        `L ${x1} ${y1}`,
        `A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`,
        'Z',
      ].join(' ');

      currentAngle += angle;

      return {
        path: pathData,
        color: d.color!,
        label: d.label,
      };
    });

    return m(
      'svg',
      {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
      },
      paths.map(p =>
        m('path', {
          d: p.path,
          fill: p.color,
          stroke: 'var(--background)',
          strokeWidth: 2,
        })
      )
    );
  }

  /**
   * 渲染柱状图
   */
  private renderBarChart(data: ChartDataPoint[], width: number, height: number): m.Children {
    const padding = { top: 20, right: 20, bottom: 40, left: 60 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // 找到最大值
    const maxValue = Math.max(...data.map(d => d.value));

    // 计算柱子宽度
    const barWidth = chartWidth / data.length * 0.8;
    const barGap = chartWidth / data.length * 0.2;

    return m(
      'svg',
      {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
      },
      [
        // Y轴
        m('line', {
          x1: padding.left,
          y1: padding.top,
          x2: padding.left,
          y2: height - padding.bottom,
          stroke: COLORS.border,
          strokeWidth: 1,
        }),

        // X轴
        m('line', {
          x1: padding.left,
          y1: height - padding.bottom,
          x2: width - padding.right,
          y2: height - padding.bottom,
          stroke: COLORS.border,
          strokeWidth: 1,
        }),

        // 柱子
        ...data.map((d, idx) => {
          const barHeight = (d.value / maxValue) * chartHeight;
          const x = padding.left + idx * (barWidth + barGap) + barGap / 2;
          const y = height - padding.bottom - barHeight;

          return [
            m('rect', {
              x,
              y,
              width: barWidth,
              height: barHeight,
              fill: d.color,
              rx: 4,
            }),
            // 值标签
            m('text', {
              x: x + barWidth / 2,
              y: y - 5,
              textAnchor: 'middle',
              fontSize: '11px',
              fill: COLORS.textSecondary,
            }, d.value.toFixed(1)),
          ];
        }),

        // Y轴刻度标签
        m('text', {
          x: padding.left - 10,
          y: padding.top,
          textAnchor: 'end',
          fontSize: '10px',
          fill: COLORS.textSecondary,
        }, maxValue.toFixed(0)),

        m('text', {
          x: padding.left - 10,
          y: height - padding.bottom,
          textAnchor: 'end',
          fontSize: '10px',
          fill: COLORS.textSecondary,
        }, '0'),
      ]
    );
  }

  /**
   * 渲染直方图
   */
  private renderHistogram(data: ChartDataPoint[], width: number, height: number): m.Children {
    // 直方图和柱状图类似，但通常用于展示频率分布
    return this.renderBarChart(data, width, height);
  }
}
