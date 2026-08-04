/**
 * 郑清 3D Creator - Hero Portrait Magnet Effect
 * 鼠标跟随磁吸效应：人像随鼠标位置轻微偏移
 * 仅在首页 (.full_page) 生效
 */
;(function () {
  'use strict'

  document.addEventListener('DOMContentLoaded', function () {
    var portrait = document.getElementById('hero-portrait')
    if (!portrait) return

    var hero = document.getElementById('custom-hero')
    if (!hero) return

    // 磁吸强度（最大偏移像素）
    var strength = 25
    // 移动端降低灵敏度
    if (window.innerWidth <= 768) strength = 15

    /**
     * 鼠标移动时计算人像偏移（相对自然位置，不含居中）
     */
    function onMouseMove(e) {
      var rect = hero.getBoundingClientRect()

      // 鼠标相对于 hero 中心的偏移，归一化到 [-1, 1]
      var centerX = rect.left + rect.width / 2
      var centerY = rect.top + rect.height / 2
      var deltaX = (e.clientX - centerX) / (rect.width / 2)
      var deltaY = (e.clientY - centerY) / (rect.height / 2)

      // 限制在 [-1, 1]，产生磁吸跟随
      var moveX = Math.max(-1, Math.min(1, deltaX)) * strength
      var moveY = Math.max(-1, Math.min(1, deltaY)) * strength

      portrait.style.transform =
        'translate(' + moveX + 'px, ' + moveY + 'px)'
    }

    /**
     * 鼠标离开时复位
     */
    function onMouseLeave() {
      portrait.style.transform = 'translate(0, 0)'
    }

    // 绑定事件
    hero.addEventListener('mousemove', onMouseMove, { passive: true })
    hero.addEventListener('mouseleave', onMouseLeave)

    // 窗口大小改变时重新判断强度
    window.addEventListener(
      'resize',
      (function () {
        var timer
        return function () {
          clearTimeout(timer)
          timer = setTimeout(function () {
            if (window.innerWidth <= 768) {
              strength = 15
            } else {
              strength = 25
            }
          }, 150)
        }
      })()
    )
  })
})()
